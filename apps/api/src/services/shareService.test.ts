import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { signShareMediaToken, verifyShareMediaToken } from './shareService';

const link = { id: 'link-1', expiresAt: new Date(Date.now() + 3600_000) };

describe('分享媒体访问凭证（密码校验凭证）', () => {
  it('密码校验通过后签发的凭证可用于读取本链接的媒体', () => {
    const token = signShareMediaToken(link);
    expect(verifyShareMediaToken(token, link.id)).toBe(true);
  });

  it('凭证不能跨链接复用', () => {
    const token = signShareMediaToken(link);
    expect(verifyShareMediaToken(token, 'link-2')).toBe(false);
  });

  it('凭证有效期不超过链接本身的过期时间', () => {
    const soon = { id: 'link-3', expiresAt: new Date(Date.now() + 120_000) };
    const decoded = jwt.decode(signShareMediaToken(soon)) as jwt.JwtPayload;
    expect(decoded.exp).toBeLessThanOrEqual(Math.floor(soon.expiresAt.getTime() / 1000));
  });

  it('普通登录令牌（缺少 share-media scope）不能当媒体凭证用', () => {
    const accessTokenLike = jwt.sign({ sysadmin: false }, config.JWT_SECRET, {
      subject: link.id,
      expiresIn: 900,
    });
    expect(verifyShareMediaToken(accessTokenLike, link.id)).toBe(false);
  });

  it('用别的密钥伪造的凭证被拒', () => {
    const forged = jwt.sign({ scope: 'share-media' }, 'another-secret-another-secret-1234', {
      subject: link.id,
      expiresIn: 900,
    });
    expect(verifyShareMediaToken(forged, link.id)).toBe(false);
  });

  it('过期凭证被拒', () => {
    const expired = jwt.sign({ scope: 'share-media', exp: Math.floor(Date.now() / 1000) - 10 }, config.JWT_SECRET, {
      subject: link.id,
    });
    expect(verifyShareMediaToken(expired, link.id)).toBe(false);
  });

  it('乱串不会抛异常，只是校验失败', () => {
    expect(verifyShareMediaToken('not-a-jwt', link.id)).toBe(false);
    expect(verifyShareMediaToken('', link.id)).toBe(false);
  });
});
