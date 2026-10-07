import type { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';
import { notFound, unauthenticated } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hashPassword, verifyPassword } from './authService';
import * as audit from './auditService';
import { shareMediaUrl, toItemDto, toShareLinkDto, type MediaVariant } from '../serializers';
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
 * 带密码的分享链接：<img>/<audio> 没法弹密码框，密码校验通过后签发一份短期凭证，
 * 作为媒体地址的 ?st= 参数。它只授予「读取本链接媒体」的能力，
 * 有效期不超过链接本身的过期时间，撤销/过期后自然失效。
 */
const SHARE_MEDIA_SCOPE = 'share-media';

export function signShareMediaToken(link: { id: string; expiresAt: Date }): string {
  const ttlSec = Math.max(60, Math.floor((link.expiresAt.getTime() - Date.now()) / 1000));
  return jwt.sign({ scope: SHARE_MEDIA_SCOPE }, config.JWT_SECRET, {
    subject: link.id,
    expiresIn: ttlSec,
  });
}

export function verifyShareMediaToken(token: string, linkId: string): boolean {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (typeof decoded === 'string') return false;
    return decoded.sub === linkId && (decoded as jwt.JwtPayload).scope === SHARE_MEDIA_SCOPE;
  } catch {
    return false;
  }
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

  // 媒体地址必须走公开路由：家庭内的 /families/:fid/media 地址要求登录，
  // 匿名访客的图片/音频会全部 401。带密码的链接在地址里附上密码校验凭证。
  const mediaAccess = link.passwordHash ? signShareMediaToken(link) : null;
  const urlFor = (mediaId: string, kind: MediaVariant) => shareMediaUrl(token, mediaId, kind, mediaAccess);

  return {
    familyName: link.family.name,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    requiresPassword: false,
    items: rows.map((r) => toItemDto(r, link.familyId, urlFor)),
  };
}

/** 访客读媒体：必须证明该媒体属于本链接覆盖的条目；带密码的链接还要出示密码校验凭证。 */
export async function assertPublicMedia(token: string, mediaId: string, access?: string) {
  const link = await loadLink(token);
  if (link.passwordHash && (!access || !verifyShareMediaToken(access, link.id))) {
    throw unauthenticated('请先在分享页通过密码校验');
  }
  const media = await prisma.itemMedia.findFirst({
    where: { id: mediaId, deletedAt: null, item: { shareLinks: { some: { shareLinkId: link.id } } } },
  });
  if (!media) throw notFound('媒体不存在');
  return media;
}

