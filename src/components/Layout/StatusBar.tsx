import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';

export default function StatusBar() {
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const selection = useAppStore((s) => s.selection);
  const zoom = useAppStore((s) => s.zoom);

  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;

  return (
    <div className="flex h-6 items-center gap-4 border-t border-[#3a3a42] bg-[#232328] px-3 text-xs text-[#8b8b92]">
      {/* Task 7 swaps to formatTime */}
      <span>cursor {cursorSample} smp</span>
      <span>
        {selection
          ? `sel ${selection.start}–${selection.end} smp (${selection.end - selection.start} smp)`
          : 'sel —'}
      </span>
      <span>
        {doc
          ? `${doc.sampleRate} Hz · ${doc.channels.length}ch · ${docLength(doc)} smp`
          : 'no document'}
      </span>
      <span className="ml-auto">spp: {zoom.samplesPerPixel}</span>
    </div>
  );
}
