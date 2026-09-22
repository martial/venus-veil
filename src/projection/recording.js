/** An export must receive its own captured pose, never count a late live reply. */
export async function recordProjectedFrame(projector, { attempts = 4, videoTime, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (projector.state.status !== 'ready') await projector.health();
    if (projector.state.status === 'ready') {
      const frameId = await projector.frame({ strict: true, videoTime });
      if (Number.isSafeInteger(frameId) && frameId > 0) return frameId;
    }
    if (attempt + 1 < attempts) await pause(200);
  }
  throw new Error(projector.state.error || 'No image received for the recorded depth. Check the projector connection and retry.');
}
