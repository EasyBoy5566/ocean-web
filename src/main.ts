import './styles.css';
import { App } from './app/app';
import { params } from './app/params';
import type { SceneId } from './world/world';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const app = new App(canvas);
const scene = (params.scene === 'ocean' || params.scene === 'river' ? params.scene : 'lake') as SceneId;
app.loadScene(scene);
void app.locate();
app.start();
