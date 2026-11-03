// Transport batching only: no text cache after the active turn, no idle poll,
// and no request deadline. First text and final flush do not wait for the window.
export function createChatDeltaCoalescer({ send, isCancelled = () => false, onError = () => {},
  intervalMs = 200, schedule = setTimeout, cancel = clearTimeout }) {
  let first = true, pending = '', timer = null, closed = false
  const clear = () => { if (timer !== null) cancel(timer); timer = null }
  const close = () => { closed = true; clear(); pending = '' }
  const flush = () => {
    clear()
    if (closed || isCancelled()) { close(); return }
    if (!pending) return
    const text = pending; pending = ''; send(text)
  }
  return {
    push(text) {
      if (closed || !text) return
      if (isCancelled()) { close(); return }
      if (first) { first = false; send(text); return }
      pending += text
      if (timer === null) {
        timer = schedule(() => {
          timer = null
          try { flush() } catch (error) { close(); onError(error) }
        }, intervalMs)
        timer?.unref?.()
      }
    },
    flush,
    close
  }
}
