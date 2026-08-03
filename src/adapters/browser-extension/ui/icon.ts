/**
 * Registry of the extension's own UI icons (docs/icon-inventory.md) — Lucide PNGs downloaded under
 * `src/assets/icon/`, imported once here so popup/dashboard/side-panel share one set of URLs
 * instead of each view re-typing its own relative import path.
 *
 * NOT for on-page floating icons/badges (`utils/ui-compositor.ts`) — those render inside a host
 * page's Shadow DOM behind `synapseApi.ui.*`, a surface uploaded scripts call too, and stay text
 * glyphs on purpose (see that file's `IconOptions`/`BadgeOptions` doc comments). This module is only
 * for the extension's own pages (popup/dashboard/side-panel), which never run third-party code.
 */
import arrowLeft from '../../../assets/icon/arrow-left.png';
import clapperboard from '../../../assets/icon/clapperboard.png';
import download from '../../../assets/icon/download.png';
import eye from '../../../assets/icon/eye.png';
import eyeOff from '../../../assets/icon/eye-off.png';
import fileText from '../../../assets/icon/file-text.png';
import info from '../../../assets/icon/info.png';
import panelRightClose from '../../../assets/icon/panel-right-close.png';
import panelRightOpen from '../../../assets/icon/panel-right-open.png';
import pause from '../../../assets/icon/pause.png';
import pencil from '../../../assets/icon/pencil.png';
import play from '../../../assets/icon/play.png';
import refreshCw from '../../../assets/icon/refresh-cw.png';
import save from '../../../assets/icon/save.png';
import settings from '../../../assets/icon/settings.png';
import square from '../../../assets/icon/square.png';
import squarePen from '../../../assets/icon/square-pen.png';
import trash from '../../../assets/icon/trash.png';
import upload from '../../../assets/icon/upload.png';
import waypoints from '../../../assets/icon/waypoints.png';
import x from '../../../assets/icon/x.png';
import zap from '../../../assets/icon/zap.png';

export const ICONS = {
  arrowLeft,
  clapperboard,
  download,
  eye,
  eyeOff,
  fileText,
  info,
  panelRightClose,
  panelRightOpen,
  pause,
  pencil,
  play,
  refreshCw,
  save,
  settings,
  square,
  squarePen,
  trash,
  upload,
  waypoints,
  x,
  zap,
} as const;

/**
 * A 16px icon `<img>`, styled by the shared `.syn-icon-img` rule each view's own CSS file defines
 * (popup.css/dashboard.css/side-panel.css — three separate Vite entry stylesheets, no shared one to
 * hang a single rule off). `alt` should stay `''` (the default) when the surrounding control already
 * carries a `title`/visible text — an image that's purely decorative inside an already-labelled
 * control must have empty alt, not a redundant one, or screen readers announce the label twice.
 */
export function icon(src: string, alt = ''): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.className = 'syn-icon-img';
  return img;
}
