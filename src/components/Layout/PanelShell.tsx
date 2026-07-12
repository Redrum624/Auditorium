import type { ReactNode } from 'react';

/** Chrome shared by every sidebar panel section (Files/Effects/History/Markers
 * placeholders in this task; Tasks 11/13 fill the body in). */
export default function PanelShell({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-b border-[#3a3a42] last:border-b-0">
      <div className="border-b border-[#3a3a42] bg-[#232328] px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-[#8b8b92]">
        {title}
      </div>
      <div className="flex-1 overflow-auto p-2 text-sm text-[#8b8b92]">{children}</div>
    </div>
  );
}
