import './styles.css';
import { App, SCENES } from './app/app';
import { params } from './app/params';
import { Hud } from './ui/hud';
import { t } from './ui/i18n';
import type { SceneId } from './world/world';

function pickScene(): SceneId {
  const fromHash = location.hash.replace('#', '');
  const want = params.scene ?? fromHash;
  return (SCENES as string[]).includes(want) ? (want as SceneId) : 'lake';
}

function fatal(message: string) {
  const div = document.createElement('div');
  div.className = 'fatal';
  div.textContent = message;
  document.body.append(div);
}

function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    fatal(t('webgl'));
    return;
  }
  let app: App;
  try {
    app = new App(canvas);
  } catch (e) {
    console.error(e);
    fatal(t('webgl'));
    return;
  }
  const hud = new Hud(app, document.getElementById('ui')!);
  // stay behind the fade until the first scene's assets have arrived
  hud.fadeEl.classList.add('on');
  app.start();
  void app.loadScene(pickScene()).then(() => requestAnimationFrame(() => hud.fadeEl.classList.remove('on')));
  void app.locate();
  if (params.autostart) hud.autostart();
  window.addEventListener('hashchange', () => {
    const id = pickScene();
    if (id !== app.sceneId) void app.switchScene(id, hud.fadeEl);
  });
}

boot();
