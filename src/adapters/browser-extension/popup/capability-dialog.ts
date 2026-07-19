/** Native <dialog>-based capability consent prompt — no framework needed for a single modal. */
export function confirmCapabilities(moduleId: string, capabilities: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <form method="dialog">
        <p>"${moduleId}" requests access to:</p>
        <ul>${capabilities.map((c) => `<li>${c}</li>`).join('')}</ul>
        <menu>
          <button value="cancel">Deny</button>
          <button value="confirm">Allow</button>
        </menu>
      </form>
    `;
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    });
    dialog.showModal();
  });
}
