// features/body/RootFixer.ts
import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";

export class RootFixer {
  private vrm: VRM;
  
  // ⚡ TWEAK THIS: Adjust this to shift her up or down on your screen
  public offsetY: number = 0.1; 

  constructor(vrm: VRM) {
    this.vrm = vrm;
    this.vrm.scene.position.set(0, this.offsetY, 0);
    this.vrm.scene.rotation.set(0, 0, 0); 
  }

  update() {
    // 1. Force Position Lock
    this.vrm.scene.position.x = 0;
    this.vrm.scene.position.y = this.offsetY;
    this.vrm.scene.position.z = 0;
    
    // 2. ⚡ Force Orientation Lock (The Anti-Tilt)
    // Prevents the scene from pitching forward/back or rolling side-to-side.
    this.vrm.scene.rotation.x = 0;
    this.vrm.scene.rotation.z = 0;
    
    this.vrm.scene.updateMatrixWorld();
  }
}