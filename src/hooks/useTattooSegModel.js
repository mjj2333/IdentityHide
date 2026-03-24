/**
 * React hook for tattoo segmentation model — training, inference, status.
 * Supports multiple named models (per subject).
 */
import { useState, useCallback, useEffect } from 'react';
import {
  loadTattooSegModel,
  isTattooSegModelTrained,
  predictTattooMask,
  deleteTattooSegModel,
  listTattooSegModels,
} from '../utils/tattooSegModel';
import { trainTattooSegModel } from '../utils/tattooSegTrain';
import { getTrainingPairCount, listSubjects, clearAllTrainingPairs } from '../utils/trainingDataStore';

export function useTattooSegModel() {
  const [selectedSubject, setSelectedSubject] = useState('default');
  const [subjects, setSubjects] = useState(['default']);
  const [modelReady, setModelReady] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState(null);
  const [pairCount, setPairCount] = useState(0);

  // Refresh the subjects list from both stored models and training data
  const refreshSubjects = useCallback(async () => {
    try {
      const [modelNames, dataSubjects] = await Promise.all([
        listTattooSegModels(),
        listSubjects(),
      ]);
      const all = new Set([...modelNames, ...dataSubjects, 'default']);
      setSubjects([...all].sort());
    } catch {}
  }, []);

  // On mount: load subjects, check model, count pairs
  useEffect(() => {
    refreshSubjects();
  }, [refreshSubjects]);

  // When selected subject changes, re-check model + pair count
  useEffect(() => {
    isTattooSegModelTrained(selectedSubject).then(setModelReady).catch(() => {});
    getTrainingPairCount(selectedSubject).then(setPairCount).catch(() => {});
  }, [selectedSubject]);

  const trainModel = useCallback(async (options = {}) => {
    setIsTraining(true);
    setTrainingProgress(null);

    try {
      const result = await trainTattooSegModel({
        ...options,
        subjectName: selectedSubject,
        onProgress: (progress) => {
          setTrainingProgress(progress);
          options.onProgress?.(progress);
        },
      });
      setModelReady(true);
      return result;
    } finally {
      setIsTraining(false);
    }
  }, [selectedSubject]);

  const predict = useCallback(async (sourceCanvas) => {
    const model = await loadTattooSegModel(selectedSubject);
    if (!model) return null;
    return predictTattooMask(model, sourceCanvas);
  }, [selectedSubject]);

  const deleteModel = useCallback(async () => {
    await deleteTattooSegModel(selectedSubject);
    setModelReady(false);
    await refreshSubjects();
  }, [selectedSubject, refreshSubjects]);

  const refreshPairCount = useCallback(async () => {
    const count = await getTrainingPairCount(selectedSubject);
    setPairCount(count);
  }, [selectedSubject]);

  const addSubject = useCallback((name) => {
    const clean = name.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    if (!clean || subjects.includes(clean)) return clean;
    setSubjects(prev => [...prev, clean].sort());
    setSelectedSubject(clean);
    return clean;
  }, [subjects]);

  const clearTrainingData = useCallback(async () => {
    await clearAllTrainingPairs(selectedSubject);
    await refreshPairCount();
  }, [selectedSubject, refreshPairCount]);

  return {
    selectedSubject,
    setSelectedSubject,
    subjects,
    addSubject,
    modelReady,
    isTraining,
    trainingProgress,
    pairCount,
    trainModel,
    predict,
    deleteModel,
    clearTrainingData,
    refreshPairCount,
    refreshSubjects,
  };
}
