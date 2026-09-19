/**
 * Bring up the first TensorFlow.js backend in `candidates` that actually
 * initialises, and return its name.
 *
 * Each candidate is `{ name, load }`, where `load` dynamically imports (and
 * configures) that backend's package. Loading lazily, in order, means the
 * fallbacks' chunks are never downloaded when the preferred backend works.
 *
 * Note tf.setBackend() RESOLVES FALSE when a backend can't initialise — it
 * doesn't throw — so a plain try/catch around it silently keeps going with no
 * backend selected. Both failure shapes are handled here.
 */
export async function selectBackend(tf, candidates) {
  for (const { name, load } of candidates) {
    try {
      await load();
      if (await tf.setBackend(name)) {
        await tf.ready();
        return name;
      }
      console.warn(`[tfBackend] ${name} backend failed to initialise, trying next`);
    } catch (err) {
      console.warn(`[tfBackend] ${name} backend unavailable, trying next:`, err?.message || err);
    }
  }
  throw new Error('No TensorFlow.js backend could be initialised');
}
