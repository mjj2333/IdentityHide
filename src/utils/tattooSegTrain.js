/**
 * On-device training for tattoo segmentation model.
 * Reads image+mask pairs from IndexedDB, augments, and trains.
 */
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import { train } from '@tensorflow/tfjs-core';
import { listTrainingPairs, getTrainingPair } from './trainingDataStore';
import {
  createTattooSegModel,
  loadTattooSegModel,
  saveTattooSegModel,
  SEG_SIZE,
} from './tattooSegModel';

// --- Data Loading ---

function blobToCanvas(blob, width, height) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load blob as image'));
    };
    img.src = url;
  });
}

async function loadTrainingData(subjectName = 'default') {
  const pairs = await listTrainingPairs(subjectName);
  console.log(`[TattooSeg] Loading ${pairs.length} training pairs for "${subjectName}"...`);

  const images = [];
  const masks = [];

  for (const { id } of pairs) {
    const pair = await getTrainingPair(id);
    if (!pair) continue;

    // Resize image to SEG_SIZE x SEG_SIZE
    const imgCanvas = await blobToCanvas(pair.imageBlob, SEG_SIZE, SEG_SIZE);
    const imgData = imgCanvas.getContext('2d').getImageData(0, 0, SEG_SIZE, SEG_SIZE).data;

    // Resize mask to SEG_SIZE x SEG_SIZE (nearest-neighbor)
    const maskCanvas = await blobToCanvas(pair.maskBlob, SEG_SIZE, SEG_SIZE);
    const maskData = maskCanvas.getContext('2d').getImageData(0, 0, SEG_SIZE, SEG_SIZE).data;

    // Convert image to float32 [SEG_SIZE, SEG_SIZE, 3] (0-1)
    const imgFloat = new Float32Array(SEG_SIZE * SEG_SIZE * 3);
    for (let i = 0; i < SEG_SIZE * SEG_SIZE; i++) {
      imgFloat[i * 3] = imgData[i * 4] / 255;
      imgFloat[i * 3 + 1] = imgData[i * 4 + 1] / 255;
      imgFloat[i * 3 + 2] = imgData[i * 4 + 2] / 255;
    }

    // Convert mask to float32 [SEG_SIZE, SEG_SIZE, 1] (0 or 1, from alpha channel)
    const maskFloat = new Float32Array(SEG_SIZE * SEG_SIZE);
    for (let i = 0; i < SEG_SIZE * SEG_SIZE; i++) {
      maskFloat[i] = maskData[i * 4 + 3] > 128 ? 1.0 : 0.0;
    }

    images.push(tf.tensor3d(imgFloat, [SEG_SIZE, SEG_SIZE, 3]));
    masks.push(tf.tensor3d(maskFloat, [SEG_SIZE, SEG_SIZE, 1]));
  }

  return { images, masks };
}

// --- Augmentation ---

function augmentPair(image, mask) {
  return tf.tidy(() => {
    let img = image;
    let msk = mask;

    // Random horizontal flip (50%)
    if (Math.random() > 0.5) {
      img = tf.reverse(img, 1);
      msk = tf.reverse(msk, 1);
    }

    // Random brightness (image only, +-0.15)
    const brightness = (Math.random() - 0.5) * 0.3;
    img = tf.clipByValue(tf.add(img, brightness), 0, 1);

    // Random contrast (image only, 0.8-1.2)
    const contrast = 0.8 + Math.random() * 0.4;
    const mean = tf.mean(img);
    img = tf.clipByValue(tf.add(tf.mul(tf.sub(img, mean), contrast), mean), 0, 1);

    return { image: img, mask: msk };
  });
}

// --- Loss Function ---

function combinedLoss(yTrue, yPred) {
  return tf.tidy(() => {
    // Binary cross-entropy
    const eps = 1e-7;
    const clipped = tf.clipByValue(yPred, eps, 1 - eps);
    const bce = tf.mean(tf.neg(
      tf.add(
        tf.mul(yTrue, tf.log(clipped)),
        tf.mul(tf.sub(1, yTrue), tf.log(tf.sub(1, clipped)))
      )
    ));

    // Dice loss (handles class imbalance)
    const smooth = 1;
    const intersection = tf.sum(tf.mul(yTrue, yPred));
    const union = tf.add(tf.sum(yTrue), tf.sum(yPred));
    const dice = tf.sub(1, tf.div(tf.add(tf.mul(2, intersection), smooth), tf.add(union, smooth)));

    return tf.add(bce, dice);
  });
}

// --- Training ---

/**
 * Train the tattoo segmentation model.
 * @param {Object} options
 * @param {number} options.epochs - Number of training epochs (default: 30)
 * @param {number} options.batchSize - Batch size (default: 2)
 * @param {number} options.learningRate - Learning rate (default: 0.001)
 * @param {Function} options.onProgress - Callback: ({epoch, totalEpochs, loss, elapsed})
 * @returns {Promise<{model, finalLoss, elapsed}>}
 */
export async function trainTattooSegModel(options = {}) {
  const {
    epochs = 30,
    batchSize = 2,
    learningRate = 0.001,
    subjectName = 'default',
    onProgress,
  } = options;

  await tf.setBackend('webgl');
  await tf.ready();

  // Load or create model
  let model = await loadTattooSegModel(subjectName);
  if (!model) {
    console.log(`[TattooSeg] Creating new model for "${subjectName}"...`);
    model = createTattooSegModel();
  }

  // Load training data
  const { images, masks } = await loadTrainingData(subjectName);
  if (images.length < 2) {
    // Dispose loaded tensors
    images.forEach(t => t.dispose());
    masks.forEach(t => t.dispose());
    throw new Error('Need at least 2 training pairs');
  }

  console.log(`[TattooSeg] Training with ${images.length} pairs, ${epochs} epochs, batch=${batchSize}`);

  const optimizer = train.adam(learningRate);
  const t0 = performance.now();
  let lastLoss = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Shuffle indices
    const indices = Array.from({ length: images.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    let epochLoss = 0;
    let batchCount = 0;

    for (let b = 0; b < indices.length; b += batchSize) {
      const batchIndices = indices.slice(b, b + batchSize);

      // Augment and stack outside optimizer to limit gradient tape scope
      const batchImages = tf.tidy(() => {
        const augmented = batchIndices.map(i => augmentPair(images[i], masks[i]));
        return tf.stack(augmented.map(a => a.image));
      });
      const batchMasks = tf.tidy(() => {
        const augmented = batchIndices.map(i => augmentPair(images[i], masks[i]));
        return tf.stack(augmented.map(a => a.mask));
      });

      // Train step — minimize returns a scalar, dispose it after reading
      const lossVal = optimizer.minimize(() => {
        const pred = model.apply(batchImages, { training: true });
        return combinedLoss(batchMasks, pred);
      }, true);

      epochLoss += lossVal.dataSync()[0];
      lossVal.dispose();
      batchImages.dispose();
      batchMasks.dispose();
      batchCount++;
    }

    lastLoss = epochLoss / batchCount;
    const elapsed = (performance.now() - t0) / 1000;

    if (onProgress) {
      onProgress({ epoch: epoch + 1, totalEpochs: epochs, loss: lastLoss, elapsed });
    }

    if ((epoch + 1) % 10 === 0 || epoch === 0) {
      console.log(`[TattooSeg] Epoch ${epoch + 1}/${epochs} loss=${lastLoss.toFixed(4)} (${elapsed.toFixed(1)}s)`);
    }
  }

  // Save model
  await saveTattooSegModel(model, subjectName);

  // Dispose training data tensors
  images.forEach(t => t.dispose());
  masks.forEach(t => t.dispose());
  optimizer.dispose();

  const elapsed = (performance.now() - t0) / 1000;
  console.log(`[TattooSeg] Training complete: loss=${lastLoss.toFixed(4)}, ${elapsed.toFixed(1)}s`);

  return { model, finalLoss: lastLoss, elapsed };
}
