import { Color, Texture, Vector3 } from 'three';

/**
 * Uniform objects shared by reference between all materials. Spreading this
 * object into a ShaderMaterial's `uniforms` keeps every material in sync when
 * the environment updates a value.
 */
export const globals = {
  uTime: { value: 0 },
  uSunDir: { value: new Vector3(0, 1, 0) },
  uMoonDir: { value: new Vector3(0, -1, 0) },
  uSunColor: { value: new Color(0, 0, 0) },
  uMoonColor: { value: new Color(0, 0, 0) },
  uSkyAmbient: { value: new Color(0, 0, 0) },
  uGroundAmbient: { value: new Color(0, 0, 0) },
  uSkyLUT: { value: null as Texture | null },
  uNoiseTex: { value: null as Texture | null },
  uExposure: { value: 1 },
  uFogDensity: { value: 1.5e-4 },
  uMist: { value: 0 },
  uMistHeight: { value: 12 },
  uReflectionPass: { value: 0 },
  uWaterLevel: { value: 0 },
  uWaterAbsorb: { value: new Vector3(0.45, 0.09, 0.07) },
  uWaterScatter: { value: new Vector3(0.01, 0.03, 0.04) },
  uNight: { value: 0 },
};

export type Globals = typeof globals;
