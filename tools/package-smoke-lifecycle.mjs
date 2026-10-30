// StdioClientTransport 2.1.0 close() is best effort. Its public onclose callback
// comes from the owned child process close event, and Protocol.connect chains it.
export function observeSmokeTransportClosure(transport) {
  const previous = transport.onclose;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  transport.onclose = () => { resolveClosed(); previous?.(); };
  return async timeoutMs => {
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Installed MCP child exit unconfirmed')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}
