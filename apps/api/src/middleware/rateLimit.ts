import rateLimit from 'express-rate-limit';
import { AppError } from '../http/errors';

const handler = (_req: unknown, _res: unknown, next: (err: unknown) => void) =>
  next(new AppError('RATE_LIMITED', '操作过于频繁，请稍后再试'));

/** 登录/注册：按 IP 限制，防暴力破解。 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** 写操作：按用户限流（未登录时按 IP）。 */
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
  handler,
});

/** 公开分享页：防止匿名爆破访问密码。 */
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/**
 * 分享页媒体文件：访问本身由签名凭证把关，这里只防抓取滥用。
 * 额度要容得下一整个相册页（缩略图 + 大图 + 音频流）一次性加载。
 */
export const publicMediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

