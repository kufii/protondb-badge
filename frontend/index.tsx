import { definePlugin, Millennium, Field, Toggle } from '@steambrew/client';
import { UIMode } from './injection/detector';
import { setupObserver, disconnectObserver } from './injection/observer';

let currentDocument: Document | undefined;
let currentUIMode: UIMode | undefined;

export default definePlugin(() => {
  console.log('[ProtonDB] plugin loading...');

  Millennium.AddWindowCreateHook?.((context: any) => {
    // Only handle main Steam windows (Desktop or Big Picture)
    if (!context.m_strName?.startsWith('SP ')) return;

    const doc = context.m_popup?.document;
    if (!doc?.body) return;

    const mode: UIMode = context.m_strName.includes('BPM')
      ? UIMode.BigPicture
      : UIMode.Desktop;
    console.log('[ProtonDB] Window created:', context.m_strName, `(${mode})`);

    // Clean up previous observer if document/mode is switching
    const documentChanged = currentDocument && currentDocument !== doc;
    const modeChanged = currentUIMode !== undefined && currentUIMode !== mode;
    if (documentChanged || modeChanged) {
      console.log('[ProtonDB] Mode/document switch detected, cleaning up');
      disconnectObserver();
    }

    currentDocument = doc;
    currentUIMode = mode;
    setupObserver(doc, mode);
  });

  return {
    title: 'ProtonDB Status',
    icon: null,
    onDismount() {
      disconnectObserver();
    },
    content: (
      <Field label='Show ProtonDB Status'>
        <Toggle
          value={localStorage.getItem('protondb-status.show') !== 'false'}
          onChange={(value: boolean) => {
            localStorage.setItem('protondb-status.show', String(value));
          }}
        />
      </Field>
    )
  };
});
