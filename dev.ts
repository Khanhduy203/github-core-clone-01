// Local development runner: start the forge on a fixed port without the env
// lifecycle, so the kit's scorer can be run against it:
//
//   MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts 3000
//   node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:3000 --token test-token
//
// The trial runs main.ts instead; this file is only a convenience for testing.

import { createApp } from './app.ts';

const port = Number(process.argv[2] ?? '3000');
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
});
