// Micro, détection de la parole et lecture du son. Utilisé par l'assistant et par la page de test.

const TAUX_SORTIE = 16000;
const modulesCharges = new WeakSet();

export async function ouvrirMicro(contexte, surTrame) {
  const flux = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (!modulesCharges.has(contexte)) {
    await contexte.audioWorklet.addModule("/capture.js");
    modulesCharges.add(contexte);
  }
  const source = contexte.createMediaStreamSource(flux);
  const noeud = new AudioWorkletNode(contexte, "capture-trinocle");
  noeud.port.onmessage = (e) => surTrame(e.data);
  source.connect(noeud);
  noeud.connect(contexte.destination); // Le nœud n'émet que du silence : ce lien garde Safari éveillé.
  return {
    fermer() {
      noeud.port.onmessage = null;
      source.disconnect();
      noeud.disconnect();
      flux.getTracks().forEach((piste) => piste.stop());
    },
  };
}

// Repère le début et la fin d'une prise de parole à partir du volume, en suivant le bruit ambiant.
export class DetecteurParole {
  constructor(taux, { surFin, surDebut = () => {}, silenceFinMs = 850, maxMs = 20000 }) {
    Object.assign(this, { taux, surFin, surDebut, silenceFinMs, maxMs });
    this.reinitialiser();
    this.bruit = 0.004;
  }

  reinitialiser() {
    this.enParole = false;
    this.preRoulage = [];
    this.prise = [];
    this.voixMs = 0;
    this.silenceMs = 0;
    this.dureeMs = 0;
    this.voixTotaleMs = 0;
    this.niveau = 0;
  }

  trame(echantillons) {
    let somme = 0;
    for (let i = 0; i < echantillons.length; i += 1) somme += echantillons[i] * echantillons[i];
    const rms = Math.sqrt(somme / echantillons.length);
    const ms = (echantillons.length / this.taux) * 1000;
    const seuil = Math.max(0.012, this.bruit * 2.8);
    this.niveau = Math.min(1, rms * 9);

    if (!this.enParole) {
      this.preRoulage.push(echantillons);
      while (this.preRoulage.length * ms > 320) this.preRoulage.shift();
      if (rms > seuil) {
        this.voixMs += ms;
        if (this.voixMs >= 120) {
          this.enParole = true;
          this.prise = this.preRoulage.slice();
          this.preRoulage = [];
          this.dureeMs = this.prise.length * ms;
          this.voixTotaleMs = this.voixMs;
          this.silenceMs = 0;
          this.surDebut();
        }
      } else {
        this.voixMs = 0;
        this.bruit += (rms - this.bruit) * 0.02;
      }
      return;
    }

    this.prise.push(echantillons);
    this.dureeMs += ms;
    if (rms > seuil * 0.7) {
      this.silenceMs = 0;
      this.voixTotaleMs += ms;
    } else {
      this.silenceMs += ms;
    }
    if (this.silenceMs >= this.silenceFinMs || this.dureeMs >= this.maxMs) this.terminer();
  }

  // Termine la prise tout de suite. Une prise trop courte est un bruit : elle est jetée.
  terminer() {
    if (!this.enParole) return;
    const prise = this.prise;
    const suffisant = this.voixTotaleMs >= 300;
    this.reinitialiser();
    if (suffisant) this.surFin(prise);
  }
}

// Whisper attend du 16 kHz : on réduit le son du téléphone, puis on l'emballe en WAV.
export function priseEnWavBase64(trames, tauxEntree) {
  const total = trames.reduce((s, t) => s + t.length, 0);
  const rapport = tauxEntree / TAUX_SORTIE;
  const nombre = Math.floor(total / rapport);
  const pcm = new Int16Array(nombre);
  let indice = 0;
  let cumul = 0;
  let compte = 0;
  let suivant = rapport;
  let position = 0;
  for (const trame of trames) {
    for (let i = 0; i < trame.length; i += 1) {
      cumul += trame[i];
      compte += 1;
      position += 1;
      if (position >= suivant && indice < nombre) {
        const valeur = Math.max(-1, Math.min(1, cumul / compte));
        pcm[indice] = valeur * 32767;
        indice += 1;
        cumul = 0;
        compte = 0;
        suivant += rapport;
      }
    }
  }

  const entete = new DataView(new ArrayBuffer(44));
  const ecrireTexte = (decalage, texte) => {
    for (let i = 0; i < texte.length; i += 1) entete.setUint8(decalage + i, texte.charCodeAt(i));
  };
  const octets = pcm.length * 2;
  ecrireTexte(0, "RIFF");
  entete.setUint32(4, 36 + octets, true);
  ecrireTexte(8, "WAVEfmt ");
  entete.setUint32(16, 16, true);
  entete.setUint16(20, 1, true);
  entete.setUint16(22, 1, true);
  entete.setUint32(24, TAUX_SORTIE, true);
  entete.setUint32(28, TAUX_SORTIE * 2, true);
  entete.setUint16(32, 2, true);
  entete.setUint16(34, 16, true);
  ecrireTexte(36, "data");
  entete.setUint32(40, octets, true);

  const fichier = new Uint8Array(44 + octets);
  fichier.set(new Uint8Array(entete.buffer), 0);
  fichier.set(new Uint8Array(pcm.buffer), 44);
  let binaire = "";
  for (let i = 0; i < fichier.length; i += 0x8000) {
    binaire += String.fromCharCode.apply(null, fichier.subarray(i, i + 0x8000));
  }
  return btoa(binaire);
}

export async function decoderBase64(contexte, base64) {
  const binaire = atob(base64);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
  return contexte.decodeAudioData(octets.buffer);
}

// Joue un son décodé. La promesse se résout à la fin, ou dès qu'on l'arrête.
export function jouerTampon(contexte, tampon, analyseur) {
  const source = contexte.createBufferSource();
  source.buffer = tampon;
  source.connect(analyseur ?? contexte.destination);
  const fini = new Promise((resoudre) => {
    source.onended = resoudre;
  });
  source.start();
  return {
    fini,
    arreter() {
      try {
        source.stop();
      } catch {
        // Déjà terminé.
      }
    },
  };
}

// Voix intégrée au téléphone : solution de secours, et point de comparaison pour la page de test.
// Si le téléphone n'a pas de voix dans cette langue, il prend sa voix par défaut.
const VOIX_TELEPHONE = {
  fr: { code: "fr-FR", preferees: /google|audrey|amelie|thomas|premium|enhanced/i },
  en: { code: "en-US", preferees: /google|samantha|daniel|premium|enhanced/i },
  zh: { code: "zh-CN", preferees: /google|tingting|ting-ting|meijia|premium|enhanced/i },
};

export function parlerNavigateur(texte, langue = "fr") {
  if (!("speechSynthesis" in window)) return { fini: Promise.resolve(), arreter() {} };
  const reglage = VOIX_TELEPHONE[langue] ?? VOIX_TELEPHONE.fr;
  const enonce = new SpeechSynthesisUtterance(texte);
  enonce.lang = reglage.code;
  const prefixe = reglage.code.slice(0, 2);
  const voix = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(prefixe));
  enonce.voice = voix.find((v) => reglage.preferees.test(v.name)) ?? voix[0] ?? null;
  enonce.rate = 1.02;
  let garde;
  const han = (texte.match(/\p{Script=Han}/gu) ?? []).length;
  const fini = new Promise((resoudre) => {
    enonce.onend = resoudre;
    enonce.onerror = resoudre;
    // Certains téléphones n'annoncent jamais la fin : on repart quand même.
    garde = setTimeout(resoudre, (texte.length - han) * 95 + han * 260 + 2500);
  }).finally(() => clearTimeout(garde));
  speechSynthesis.cancel();
  speechSynthesis.speak(enonce);
  return { fini, arreter: () => speechSynthesis.cancel() };
}

// Texte lisible de ce qu'a consommé un échange, pour le mode ?mesures et la page de test.
const nombre = (n) => Number(n ?? 0).toLocaleString("fr-FR", { maximumFractionDigits: 1 });

export function texteConsommation(conso, { parJour: avecParJour = true } = {}) {
  if (!conso?.neurones) return "";
  const n = conso.neurones;
  const morceaux = [];
  if (n.transcription) morceaux.push(`écoute ${nombre(n.transcription)}`);
  if (n.reponse) morceaux.push(`réponse ${nombre(n.reponse)}`);
  if (n.voix) morceaux.push(`voix ${nombre(n.voix)}`);
  const jetons = conso.jetonsLus ? ` ${nombre(conso.jetonsLus)} jetons lus et ${nombre(conso.jetonsEcrits)} écrits.` : "";
  const parJour = avecParJour && n.total > 0 ? ` À ce rythme, environ ${nombre(Math.floor(10000 / n.total))} échanges gratuits par jour.` : "";
  return `Consommation${conso.estime ? " estimée" : ""} : ${nombre(n.total)} neurones${morceaux.length ? ` (${morceaux.join(", ")})` : ""}.${jetons}${parJour}`;
}
