/**
 * @file __test__/ffmpegEncode.test.ts
 * @description Contract for the ffmpeg movie-encode argument builder (ports
 * UXP anim-render-dlg submitFFmpegTasks): frame pattern, per-format codec /
 * container, yuv420p only for h264/h265, and the rate control per format
 * (CRF for h264/h265 in quality mode, -b:v otherwise, nothing for raw / GIF).
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  buildFfmpegArgs,
  movieFileName,
  movieOutputPath,
  type FfmpegEncodeOptions,
} from '@renderer/worker/server/services/renderjob/ffmpegEncode';

/** A file in the output dir, joined with this platform's separator. */
const out = (name: string) => path.join('/out', name);

const base: FfmpegEncodeOptions = {
  outputDir: '/out',
  baseName: 'movie',
  fps: 30,
  frameCount: 60,
  format: 'mp4_h264',
  rateControl: 'bitrate',
  quality: 'high',
  bitrateKbps: 1024,
};

describe('ffmpeg encode args', () => {
  it('builds the h264 command with the frame pattern, count, bitrate and yuv420p', () => {
    const args = buildFfmpegArgs(base);
    expect(args).toContain('-r 30');
    expect(args).toContain(`-i "${out('movie_frm_%04d.png')}"`);
    expect(args).toContain('-vframes 60');
    expect(args).toContain('-b:v 1024k');
    expect(args).toContain('-c:v libx264 -f mp4');
    expect(args).toContain('-vf "fps=30,format=yuv420p"');
    expect(args).toContain('-y');
    expect(args).toContain(`"${out('movie.mp4')}"`);
  });

  it('omits the bit rate for the raw codec', () => {
    const args = buildFfmpegArgs({ ...base, format: 'mov_raw' });
    expect(args).not.toContain('-b:v');
    expect(args).toContain('-c:v rawvideo -f mov');
    // No yuv420p for a non-h264/h265 codec.
    expect(args).toContain('-vf "fps=30"');
    expect(args).toContain(`"${out('movie.mov')}"`);
  });

  it('uses CRF in quality mode, mapped per encoder', () => {
    const h264 = buildFfmpegArgs({ ...base, rateControl: 'quality', quality: 'high' });
    expect(h264).toContain('-crf 18');
    expect(h264).not.toContain('-b:v');
    // x265 needs a higher CRF than x264 for similar quality.
    const h265 = buildFfmpegArgs({ ...base, format: 'mp4_h265', rateControl: 'quality', quality: 'high' });
    expect(h265).toContain('-crf 23');
    // A codec without CRF falls back to the bit rate even in quality mode.
    const wmv = buildFfmpegArgs({ ...base, format: 'wmv2', rateControl: 'quality' });
    expect(wmv).toContain('-b:v 1024k');
    expect(wmv).not.toContain('-crf');
  });

  it('emits no codec option for animated GIF', () => {
    const args = buildFfmpegArgs({ ...base, format: 'gifanim' });
    expect(args).not.toContain('-c:v');
    expect(args).toContain(`"${out('movie.gif')}"`);
  });

  it('tags HEVC for QuickTime H.265', () => {
    const args = buildFfmpegArgs({ ...base, format: 'mov_h265' });
    expect(args).toContain('-c:v libx265 -tag hvc1 -f mov');
    expect(args).toContain('-vf "fps=30,format=yuv420p"');
  });

  it('maps the output file name to the format extension', () => {
    expect(movieFileName('clip', 'mp4_h264')).toBe('clip.mp4');
    expect(movieFileName('clip', 'gifanim')).toBe('clip.gif');
    expect(movieOutputPath({ ...base, baseName: 'clip', format: 'wmv2' })).toBe(out('clip.wmv'));
  });
});
