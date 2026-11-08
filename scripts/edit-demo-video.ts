// Keep only actual recorded action windows and accelerate them uniformly.
// The manifest preserves the model-run IDs and source timing for provenance.
interface Recording {
  scenario: string;
  runId: string;
  fps?: number;
  path: string;
  clips: { start: number; end: number }[];
}
const root = `${import.meta.dir}/..`;
const recordings = (await Bun.file(
  `${root}/data/video-source/${process.argv.includes('--smooth') ? 'manifest-smooth' : 'manifest'}.json`,
).json()) as Recording[];
if (recordings.length !== 2) throw new Error('Both scenario recordings are required');
const parts: string[] = [];
for (const [index, recording] of recordings.entries()) {
  // Omit repeated attempts so the landing cut emphasizes distinct visible states.
  const highlights =
    recording.scenario === 'shop'
      ? recording.clips.filter((_, i) => [0, 1, 2, 3, 15, 18, 19, 20].includes(i))
      : recording.clips.filter((_, i) => i <= 16);
  const selection = highlights
    .map((clip) => `between(t,${clip.start.toFixed(3)},${clip.end.toFixed(3)})`)
    .join('+');
  const output = `${root}/data/video-source/${recording.scenario}-cut.mp4`;
  const command = Bun.spawn(
    [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      recording.path,
      '-vf',
      `select='${selection}',setpts=N/(${recording.fps ?? 25}*1.5*TB),crop=iw-16:ih:0:0,fps=${recording.fps ?? 30}`,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '19',
      '-pix_fmt',
      'yuv420p',
      output,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await command.exited) !== 0) throw new Error(`Encoding failed for source ${index}`);
  parts.push(`file '${output}'`);
}
await Bun.write(`${root}/data/video-source/concat.txt`, parts.join('\n'));
const output = `${root}/public/media/sightline-browser-demo.mp4`;
const command = Bun.spawn(
  [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    `${root}/data/video-source/concat.txt`,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
if ((await command.exited) !== 0) throw new Error('Video assembly failed');
const poster = Bun.spawn(
  [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    '2',
    '-i',
    output,
    '-frames:v',
    '1',
    `${root}/public/media/sightline-browser-demo-poster.jpg`,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
if ((await poster.exited) !== 0) throw new Error('Poster generation failed');
console.log(output);
