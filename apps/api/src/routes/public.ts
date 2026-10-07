import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler';
import { publicLimiter } from '../middleware/rateLimit';
import * as shareService from '../services/shareService';
import { mediaFileTarget } from '../services/mediaService';
import { sendStoredFile } from '../http/sendFile';
import { notFound } from '../http/errors';

export const publicRouter = Router();

publicRouter.post(
  '/share/:token',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
    res.json({ share: await shareService.viewShareLink(req.params.token!, password) });
  }),
);

publicRouter.get(
  '/share/:token/media/:mediaId/:variant',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const variant = req.params.variant!;
    if (!['raw', 'thumb', 'waveform', 'download'].includes(variant)) throw notFound('媒体不存在');
    const key = typeof req.query.key === 'string' ? req.query.key : undefined;
    const media = await shareService.assertPublicMedia(req.params.token!, req.params.mediaId!, key);
    const target = await mediaFileTarget(media, variant as 'raw' | 'thumb' | 'waveform' | 'download');
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: variant === 'waveform' ? `${media.id}.waveform.json` : media.originalName,
      download: variant === 'download',
    });
  }),
);

