/**
 * Evaluate an expression in the running FAIONYX renderer through Electron CDP.
 *
 * Usage:
 *   node scripts/cdp-eval.mjs "document.body.innerText"
 *
 * Start Electron with `--remote-debugging-port=9222` first. This helper is
 * intentionally dependency-free so diagnostic runs do not change the app's
 * runtime dependency graph.
 */

const expression = process.argv.slice(2).join(' ').trim();
if (!expression) throw new Error('Missing JavaScript expression');

const targetsResponse = await fetch('http://127.0.0.1:9222/json/list');
if (!targetsResponse.ok) throw new Error(`CDP target list failed: HTTP ${targetsResponse.status}`);

const targets = await targetsResponse.json();
const page = targets.find((target) => target.type === 'page' && target.title === 'FAIONYX');
if (!page?.webSocketDebuggerUrl) throw new Error('FAIONYX renderer CDP target not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const timeout = setTimeout(() => {
  socket.close();
  throw new Error('CDP evaluation timed out');
}, 15_000);

const result = await new Promise((resolve, reject) => {
  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      })
    );
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    if (message.error) reject(new Error(message.error.message));
    else if (message.result?.exceptionDetails) {
      reject(new Error(message.result.exceptionDetails.text || 'Renderer evaluation failed'));
    } else resolve(message.result?.result?.value);
  });
  socket.addEventListener('error', () => reject(new Error('CDP socket failed')));
});

clearTimeout(timeout);
socket.close();
if (typeof result === 'string') process.stdout.write(result);
else process.stdout.write(JSON.stringify(result, null, 2));
