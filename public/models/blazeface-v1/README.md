# BlazeFace model (self-hosted)

The face-detection model used by `src/hooks/useFaceDetection.js`, served from
our own origin instead of being downloaded from a third party at runtime.

- **Source:** `https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1`
  (the default URL baked into `@tensorflow-models/blazeface@0.1.0`; tfhub now
  redirects to kaggle.com, which redirects to a signed Google Cloud Storage URL)
- **Fetched:** 2026-09-18, unmodified
- **License:** Apache-2.0 (TensorFlow Hub / MediaPipe BlazeFace)
- **Format:** TF.js graph model — `model.json` manifest + one weights shard

| File | Bytes | SHA-256 |
|---|---|---|
| `model.json` | 64,036 | `7b6bb6f35e5a7899232de51dda8bf514ef9664ca7ec58388c9fecc088c883b58` |
| `group1-shard1of1.bin` | 401,768 | `60b481ab6c19352673cdb21e02e639f90883db1393ac52d07c7ea4e1e11cb2cd` |

The shard size equals the sum of the tensor sizes declared in `model.json`.

## Why it is here

The runtime download meant a third-party request on every cold load, no face
detection offline, and hard failures whenever the redirect chain answered
without CORS headers ("Auto face detection failed").

## Rules

- **Never edit these files in place.** The folder is served with
  `Cache-Control: immutable` (see `netlify.toml`) and cached by the service
  worker. A different model goes in a new folder (`blazeface-v2/`) with the URL
  in `useFaceDetection.js` updated to match.
