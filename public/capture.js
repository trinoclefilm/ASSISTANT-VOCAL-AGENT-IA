// Tourne dans le fil audio du navigateur : regroupe le son du micro et l'envoie à la page.
class CaptureTrinocle extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tampon = new Float32Array(2048);
    this.rempli = 0;
  }

  process(entrees) {
    const canal = entrees[0]?.[0];
    if (canal) {
      for (let i = 0; i < canal.length; i += 1) {
        this.tampon[this.rempli] = canal[i];
        this.rempli += 1;
        if (this.rempli === this.tampon.length) {
          this.port.postMessage(this.tampon.slice(0));
          this.rempli = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture-trinocle", CaptureTrinocle);
