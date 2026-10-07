import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../utils/crypto';

const mocks = vi.hoisted(() => ({
  shareLinkFindUnique: vi.fn(),
  shareLinkUpdate: vi.fn(),
  itemFindMany: vi.fn(),
  itemMediaFindFirst: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    shareLink: { findUnique: mocks.shareLinkFindUnique, update: mocks.shareLinkUpdate },
    item: { findMany: mocks.itemFindMany },
    itemMedia: { findFirst: mocks.itemMediaFindFirst },
  },
}));

import { hashPassword } from './authService';
import { assertPublicMedia, isValidMediaKey, mediaAccessKey, viewShareLink } from './shareService';

describe('分享链接媒体通行凭证', () => {
  const link = { id: 'link_1', passwordHash: 'hash-a' };

  it('同一链接的凭证稳定，可重复校验', () => {
    expect(mediaAccessKey(link)).toBe(mediaAccessKey({ ...link }));
  });

  it('凭证是 URL 安全的 base64url，可以直接放进查询参数', () => {
    expect(mediaAccessKey(link)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('链接不同或密码散列不同，凭证都不同', () => {
    const base = mediaAccessKey(link);
    expect(mediaAccessKey({ id: 'link_2', passwordHash: 'hash-a' })).not.toBe(base);
    expect(mediaAccessKey({ id: 'link_1', passwordHash: 'hash-b' })).not.toBe(base);
    expect(mediaAccessKey({ id: 'link_1', passwordHash: null })).not.toBe(base);
  });

  it('只接受完全匹配的凭证', () => {
    const key = mediaAccessKey(link);
    expect(isValidMediaKey(link, key)).toBe(true);
    expect(isValidMediaKey(link, undefined)).toBe(false);
    expect(isValidMediaKey(link, '')).toBe(false);
    expect(isValidMediaKey(link, key.slice(0, -1))).toBe(false);
    expect(isValidMediaKey(link, `${key}x`)).toBe(false);
    expect(isValidMediaKey({ id: 'link_1', passwordHash: 'other' }, key)).toBe(false);
    expect(isValidMediaKey({ id: 'link_2', passwordHash: 'hash-a' }, key)).toBe(false);
  });
});

/** 下面是「匿名访客打开分享页」的完整链路：密码校验 → 拿到媒体地址 → 凭地址拉取媒体。 */
describe('匿名访客分享链路（mock 数据库）', () => {
  const TOKEN = 'share-token-for-test';
  let passwordHash: string;

  const makeLink = () => ({
    id: 'link1',
    familyId: 'fam1',
    tokenHash: sha256Hex(TOKEN),
    passwordHash,
    label: '给二叔看看',
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    accessCount: 0,
    lastAccessAt: null,
    createdBy: 'user1',
    createdAt: new Date('2024-01-01'),
    family: { id: 'fam1', name: '张家' },
  });

  const image = {
    id: 'media-img',
    itemId: 'item1',
    kind: 'image',
    status: 'ready',
    mimeType: 'image/jpeg',
    byteSize: 1024n,
    width: 800,
    height: 600,
    durationMs: null,
    originalName: '箱子.jpg',
    caption: null,
    transcript: null,
    sortOrder: 0,
    storageKey: 'fam1/ab/img.jpg',
    sha256: 'ab',
    thumbKey: 'fam1/ab/thumb.webp',
    waveformKey: null,
    transcodeKey: null,
    lastError: null,
    deletedAt: null,
    createdBy: 'user1',
    createdAt: new Date('2024-01-01'),
  };

  const audio = {
    ...image,
    id: 'media-audio',
    kind: 'audio',
    mimeType: 'audio/mpeg',
    originalName: '口述.mp3',
    durationMs: 60_000,
    sortOrder: 1,
    thumbKey: null,
    waveformKey: 'fam1/cd/waveform.json',
    transcodeKey: 'fam1/cd/audio.mp3',
  };

  const makeItem = (media: unknown[]) => ({
    id: 'item1',
    familyId: 'fam1',
    title: '樟木箱',
    category: 'furniture',
    status: 'published',
    visibility: 'link',
    acquiredAt: null,
    acquiredPrecision: 'unknown',
    acquiredLabel: '大概 1978 年',
    acquiredNote: null,
    placeText: '上海',
    placeCity: null,
    placeProvince: null,
    placeCountry: null,
    placeLat: null,
    placeLng: null,
    storyHtml: '<p>外公留下的。</p>',
    storyText: '外公留下的。',
    condition: null,
    storageLocation: null,
    tags: [],
    sortAt: new Date('2024-01-01'),
    createdBy: 'user1',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    coverMediaId: null,
    deletedAt: null,
    media,
    people: [],
    _count: { notes: 0, media: media.length },
  });

  beforeAll(async () => {
    passwordHash = await hashPassword('zhangjia');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shareLinkFindUnique.mockResolvedValue(makeLink());
    mocks.shareLinkUpdate.mockResolvedValue(makeLink());
    mocks.itemFindMany.mockResolvedValue([makeItem([image, audio])]);
    mocks.itemMediaFindFirst.mockResolvedValue(image);
  });

  it('未提供密码时不泄露条目', async () => {
    const view = await viewShareLink(TOKEN);
    expect(view.requiresPassword).toBe(true);
    expect(view.items).toEqual([]);
  });

  it('密码错误返回 401', async () => {
    await expect(viewShareLink(TOKEN, 'bad')).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('密码正确后，全部媒体变体都指向免登录公开地址并携带凭证', async () => {
    const view = await viewShareLink(TOKEN, 'zhangjia');
    expect(view.requiresPassword).toBe(false);

    const link = makeLink();
    const key = encodeURIComponent(mediaAccessKey(link));
    const base = `/api/v1/public/share/${TOKEN}/media`;
    const [img, aud] = view.items[0]!.media;

    // 图片：raw + thumb；音频：download（转码产物）+ waveform —— 四种变体全覆盖
    expect(img!.rawUrl).toBe(`${base}/media-img/raw?key=${key}`);
    expect(img!.thumbUrl).toBe(`${base}/media-img/thumb?key=${key}`);
    expect(img!.waveformUrl).toBeNull();
    expect(aud!.rawUrl).toBe(`${base}/media-audio/download?key=${key}`);
    expect(aud!.waveformUrl).toBe(`${base}/media-audio/waveform?key=${key}`);

    // 不再出现需要登录的家庭媒体地址
    for (const m of view.items[0]!.media) {
      for (const url of [m.rawUrl, m.thumbUrl, m.waveformUrl]) {
        if (url) expect(url).not.toContain('/api/v1/families/');
      }
    }
  });

  it('媒体接口只认密码校验后下发的凭证', async () => {
    const link = makeLink();
    await expect(assertPublicMedia(TOKEN, 'media-img')).rejects.toMatchObject({ status: 401 });
    await expect(assertPublicMedia(TOKEN, 'media-img', 'wrong-key')).rejects.toMatchObject({ status: 401 });
    await expect(assertPublicMedia(TOKEN, 'media-img', mediaAccessKey(link))).resolves.toMatchObject({ id: 'media-img' });
  });

  it('访客按分享页给出的地址就能拉到媒体（完整回路）', async () => {
    const view = await viewShareLink(TOKEN, 'zhangjia');
    for (const m of view.items[0]!.media) {
      for (const url of [m.rawUrl, m.thumbUrl, m.waveformUrl]) {
        if (!url) continue;
        // 模拟浏览器：从地址里取出路径与 key，请求媒体接口
        const [path, query] = url.split('?');
        const mediaId = /\/media\/([^/]+)\//.exec(path!)![1]!;
        const key = new URLSearchParams(query).get('key') ?? undefined;
        mocks.itemMediaFindFirst.mockResolvedValue(m.id === mediaId ? (m.id === 'media-img' ? image : audio) : null);
        await expect(assertPublicMedia(TOKEN, mediaId, key)).resolves.toMatchObject({ id: mediaId });
      }
    }
  });

  it('媒体不属于该链接覆盖的条目时返回 404', async () => {
    mocks.itemMediaFindFirst.mockResolvedValue(null);
    await expect(assertPublicMedia(TOKEN, 'media-x', mediaAccessKey(makeLink()))).rejects.toMatchObject({ status: 404 });
  });

  it('链接撤销后凭证随之失效', async () => {
    mocks.shareLinkFindUnique.mockResolvedValue({ ...makeLink(), revokedAt: new Date() });
    await expect(assertPublicMedia(TOKEN, 'media-img', mediaAccessKey(makeLink()))).rejects.toMatchObject({ status: 404 });
  });

  it('无密码链接：访客直接拿到带凭证的媒体地址，凭证同样能解锁媒体接口', async () => {
    const openLink = { ...makeLink(), passwordHash: null };
    mocks.shareLinkFindUnique.mockResolvedValue(openLink);

    const view = await viewShareLink(TOKEN);
    expect(view.requiresPassword).toBe(false);
    const key = mediaAccessKey(openLink);
    expect(view.items[0]!.media[0]!.rawUrl).toBe(
      `/api/v1/public/share/${TOKEN}/media/media-img/raw?key=${encodeURIComponent(key)}`,
    );
    await expect(assertPublicMedia(TOKEN, 'media-img', key)).resolves.toMatchObject({ id: 'media-img' });
  });
});
