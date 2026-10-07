import type {
  FamilyMember,
  Item,
  ItemMedia,
  ItemNote,
  ItemPerson,
  Person,
  ShareLink,
  User,
} from '@prisma/client';
import { formatAcquired, isTimeUncertain } from '@heirloom/shared';

export type MediaVariant = 'raw' | 'thumb' | 'waveform' | 'download';
/** 按场景生成媒体地址（家庭内走鉴权路由，只读分享页走公开路由） */
export type MediaUrlFor = (mediaId: string, kind: MediaVariant) => string;

export function mediaUrl(familyId: string, mediaId: string, kind: MediaVariant): string {
  return `/api/v1/families/${familyId}/media/${mediaId}/${kind}`;
}

/**
 * 只读分享页的媒体地址：走 /public 公开路由，匿名访客的 <img>/<audio> 才能加载。
 * 带密码的链接由调用方附上访问凭证（?st=），证明访客已通过密码校验。
 */
export function shareMediaUrl(shareToken: string, mediaId: string, kind: MediaVariant, access?: string | null): string {
  const base = `/api/v1/public/share/${shareToken}/media/${mediaId}/${kind}`;
  return access ? `${base}?st=${encodeURIComponent(access)}` : base;
}

export function toMediaDto(
  m: ItemMedia,
  familyId: string,
  urlFor: MediaUrlFor = (id, kind) => mediaUrl(familyId, id, kind),
) {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    mimeType: m.mimeType,
    byteSize: Number(m.byteSize),
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    originalName: m.originalName,
    caption: m.caption,
    transcript: m.transcript,
    sortOrder: m.sortOrder,
    hasThumb: Boolean(m.thumbKey),
    hasWaveform: Boolean(m.waveformKey),
    // 播放统一走转码产物（Safari 对 webm/opus 支持不一），没有转码时回落到原始文件
    rawUrl: urlFor(m.id, m.transcodeKey ? 'download' : 'raw'),
    thumbUrl: m.thumbKey ? urlFor(m.id, 'thumb') : null,
    waveformUrl: m.waveformKey ? urlFor(m.id, 'waveform') : null,
    lastError: m.lastError,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toItemDto(
  item: Item & {
    media?: ItemMedia[];
    people?: (ItemPerson & { person: Person })[];
    _count?: { notes: number; media: number };
  },
  familyId: string,
  urlFor?: MediaUrlFor,
) {
  const media = (item.media ?? []).filter((m) => !m.deletedAt);
  const cover =
    media.find((m) => m.id === item.coverMediaId && m.kind === 'image' && m.thumbKey) ??
    media.find((m) => m.kind === 'image') ??
    null;

  return {
    id: item.id,
    familyId: item.familyId,
    title: item.title,
    category: item.category,
    status: item.status,
    visibility: item.visibility,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    acquiredPrecision: item.acquiredPrecision,
    acquiredLabel: item.acquiredLabel,
    acquiredNote: item.acquiredNote,
    acquiredDisplay: formatAcquired({
      acquiredAt: item.acquiredAt,
      acquiredPrecision: item.acquiredPrecision,
      acquiredLabel: item.acquiredLabel,
    }),
    timeUncertain: isTimeUncertain({
      acquiredAt: item.acquiredAt,
      acquiredPrecision: item.acquiredPrecision,
      acquiredLabel: item.acquiredLabel,
    }),
    placeText: item.placeText,
    placeCity: item.placeCity,
    placeProvince: item.placeProvince,
    placeCountry: item.placeCountry,
    placeLat: item.placeLat ? Number(item.placeLat) : null,
    placeLng: item.placeLng ? Number(item.placeLng) : null,
    storyHtml: item.storyHtml,
    storyText: item.storyText,
    condition: item.condition,
    storageLocation: item.storageLocation,
    tags: item.tags,
    sortAt: item.sortAt.toISOString(),
    createdBy: item.createdBy,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    coverMediaId: item.coverMediaId,
    mediaCount: item._count?.media ?? media.length,
    noteCount: item._count?.notes ?? 0,
    media: media.map((m) => toMediaDto(m, familyId, urlFor)),
    people: (item.people ?? []).map((ip) => ({
      personId: ip.personId,
      role: ip.role,
      name: ip.person.name,
      relation: ip.person.relation,
    })),
  };
}

export function toPersonDto(p: Person & { _count?: { links: number } }) {
  return {
    id: p.id,
    familyId: p.familyId,
    name: p.name,
    relation: p.relation,
    birthYear: p.birthYear,
    deathYear: p.deathYear,
    bio: p.bio,
    itemCount: p._count?.links ?? 0,
    createdAt: p.createdAt.toISOString(),
  };
}

export function toNoteDto(n: ItemNote & { author?: Pick<User, 'id' | 'displayName' | 'avatarColor'> }) {
  return {
    id: n.id,
    itemId: n.itemId,
    type: n.type,
    body: n.body,
    status: n.status,
    rejectReason: n.rejectReason,
    createdAt: n.createdAt.toISOString(),
    decidedAt: n.decidedAt?.toISOString() ?? null,
    author: n.author
      ? { id: n.author.id, displayName: n.author.displayName, avatarColor: n.author.avatarColor }
      : null,
  };
}

export function toMemberDto(
  m: FamilyMember & { user: Pick<User, 'id' | 'email' | 'displayName' | 'avatarColor'> },
) {
  return {
    userId: m.userId,
    role: m.role,
    status: m.status,
    joinedAt: m.joinedAt.toISOString(),
    user: {
      id: m.user.id,
      email: m.user.email,
      displayName: m.user.displayName,
      avatarColor: m.user.avatarColor,
    },
  };
}

export function toShareLinkDto(s: ShareLink, token?: string) {
  return {
    id: s.id,
    label: s.label,
    expiresAt: s.expiresAt.toISOString(),
    revokedAt: s.revokedAt?.toISOString() ?? null,
    accessCount: s.accessCount,
    lastAccessAt: s.lastAccessAt?.toISOString() ?? null,
    hasPassword: Boolean(s.passwordHash),
    createdAt: s.createdAt.toISOString(),
    url: token ? `/share/${token}` : null,
  };
}

