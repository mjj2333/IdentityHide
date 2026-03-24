import { PipelineProvider, usePipeline } from './context/PipelineContext';
import DropZone from './components/DropZone';
import ReviewScreen from './components/ReviewScreen';
import EditorScreen from './components/EditorScreen';
import MaskEditorScreen from './components/MaskEditorScreen';
import ExportScreen from './components/ExportScreen';
import LoadingOverlay from './components/LoadingOverlay';
import ThemeToggle from './components/ThemeToggle';
import './styles/global.css';

function ScreenRouter() {
  const { screen, status } = usePipeline();

  return (
    <div className="app">
      {screen === 'drop' && <DropZone />}
      {screen === 'review' && <ReviewScreen />}
      {screen === 'mask-edit' && <MaskEditorScreen />}
      {screen === 'editor' && <EditorScreen />}
      {screen === 'export' && <ExportScreen />}
      {(status !== 'idle' && status !== 'ready' && status !== 'error') && <LoadingOverlay />}
      {status === 'error' && screen === 'drop' && <LoadingOverlay />}
    </div>
  );
}

export default function App() {
  return (
    <PipelineProvider>
      <ThemeToggle />
      <ScreenRouter />
    </PipelineProvider>
  );
}
