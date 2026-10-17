/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { GameScene } from './components/GameScene';
import { UI } from './components/UI';

export default function App() {
  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative cursor-crosshair select-none">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0, 48], fov: 60 }}
        gl={{
          antialias: false,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
      >
        <color attach="background" args={['#050505']} />
        <GameScene />
        <EffectComposer multisampling={0}>
          <Bloom
            luminanceThreshold={0.8}
            mipmapBlur
            intensity={1.2}
          />
        </EffectComposer>
      </Canvas>
      <UI />
    </div>
  );
}
