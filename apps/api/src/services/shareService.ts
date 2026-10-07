import type { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db';
import { config } from '../config';
import { notFound, unauthenticated } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hashPassword, verifyPassword } from './authService';
import * as audit from './auditService';
import { toItemDto, toShareLinkDto, type MediaUrlBuilder } from '../serializers';
import { itemWithAccess, type FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createShareLink(
  userId: string,
  ctx: FamilyContext,
  input: { itemIds: string[]; expiresInDays: number; password?: string | null; label?: string | null },
  meta: ActorMeta,
) {
  // 只能分享自己有权看到的条目，避免借分享链接绕过可见性
  for (const itemId of input.itemIds) {
    await itemWithAccess(userId, ctx, itemId);
  }

  const token = randomToken(24);
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);

  const link = await prisma.$transaction(async (tx) => {
    const created = await tx.shareLink.create({
      data: {
        familyId: ctx.familyId,
        tokenHash: sha256Hex(token),
        passwordHash,
        label: input.label ?? null,
        expiresAt,
        createdBy: userId,
        items: { create: input.itemIds.map((itemId) => ({ itemId })) },
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'share.create',
        targetType: 'share_link',
        targetId: created.id,
        diff: { itemCount: input.itemIds.length, expiresAt: expiresAt.toISOString() } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });

  return { ...toShareLinkDto(link, token), token };
}

export async function listShareLinks(ctx: FamilyContext) {
  const links = await prisma.shareLink.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return links.map((l) => toShareLinkDto(l));
}

export async function revokeShareLink(actorId: string, ctx: FamilyContext, linkId: string, meta: ActorMeta) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  await prisma.$transaction(async (tx) => {
    await tx.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'share.revoke',
        targetType: 'share_link',
        targetId: linkId,
        ...meta,
      },
      tx,
    );
  });
}

export interface PublicShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  items: ReturnType<typeof toItemDto>[];
}

async function loadLink(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { family: { select: { id: true, name: true } } },
  });
  if (!link) throw notFound('分享链接不存在或已被撤销');
  if (link.revokedAt) throw notFound('分享链接已被撤销');
  if (link.expiresAt.getTime() < Date.now()) throw notFound('分享链接已过期');
  return link;
}

/**
 * 访客拉取媒体的通行凭证：用服务端密钥对「链接 id + 密码散列」做 HMAC。
 * 只有通过密码校验（或链接本无密码）的访客才能从 viewShareLink 拿到它；
 * 链接被撤销/过期后 loadLink 直接 404，凭证随之失效。
 */
export function mediaAccessKey(link: { id: string; passwordHash: string | null }): string {
  return createHmac('sha256', config.JWT_SECRET)
    .update(`share-media:${link.id}:${link.passwordHash ?? ''}`)
    .digest('base64url');
}

export function isValidMediaKey(link: { id: string; passwordHash: string | null }, key: string | undefined): boolean {
  if (!key) return false;
  const expected = Buffer.from(mediaAccessKey(link), 'utf8');
  const actual = Buffer.from(key, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 分享页里的媒体地址：免登录，凭 mediaAccessKey 访问，覆盖 raw/thumb/waveform/download 全部变体。 */
function shareMediaUrlBuilder(token: string, key: string): MediaUrlBuilder {
  return (mediaId, kind) =>
    `/api/v1/public/share/${token}/media/${mediaId}/${kind}?key=${encodeURIComponent(key)}`;
}

export async function viewShareLink(token: string, password?: string): Promise<PublicShareView> {
  const link = await loadLink(token);

  if (link.passwordHash) {
    if (!password) {
      return { familyName: link.family.name, label: link.label, expiresAt: link.expiresAt.toISOString(), requiresPassword: true, items: [] };
    }
    const ok = await verifyPassword(password, link.passwordHash);
    if (!ok) throw unauthenticated('访问密码不正确');
  }

  const rows = await prisma.item.findMany({
    where: { shareLinks: { some: { shareLinkId: link.id } }, deletedAt: null, status: { not: 'trashed' } },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      _count: { select: { notes: true, media: true } },
    },
    orderBy: { sortAt: 'desc' },
  });

  await prisma.shareLink.update({
    where: { id: link.id },
    data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
  });

  return {
    familyName: link.family.name,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    requiresPassword: false,
    items: rows.map((r) => toItemDto(r, link.familyId, { mediaUrl: shareMediaUrlBuilder(token, mediaAccessKey(link)) })),
  };
}

/** 访客读媒体：先校验通行凭证（即密码校验的结果），再确认该媒体属于本链接覆盖的条目。 */
export async function assertPublicMedia(token: string, mediaId: string, key?: string) {
  const link = await loadLink(token);
  if (!isValidMediaKey(link, key)) throw unauthenticated('请先在分享页通过密码校验');
  const media = await prisma.itemMedia.findFirst({
    where: {
      id: mediaId,
      deletedAt: null,
      item: { deletedAt: null, status: { not: 'trashed' }, shareLinks: { some: { shareLinkId: link.id } } },
    },
  });
  if (!media) throw notFound('媒体不存在');
  return media;
}

