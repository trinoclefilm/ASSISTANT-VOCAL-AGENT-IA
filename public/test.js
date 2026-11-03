import { DetecteurParole, decoderBase64, jouerTampon, ouvrirMicro, parlerNavigateur, priseEnWavBase64 } from "/audio.js";

const $ = (id) => document.getElementById(id);
let contexte = null;
let enLecture = null;

function audio() {
  contexte ??= new (window.AudioContext || window.webkitAudioContext)();
  contexte.resume();
  return contexte;
}

$("phrase").value = $("modele").value;
$("modele").addEventListener("change", () => {
  $("phrase").value = $("modele").value;
});

$("voix-cloudflare").addEventListener("click", async () => {
  const ctx = audio();
  enLecture?.arreter();
  $("resultat-voix").textContent = "Fabrication de la voix…";
  try {
    const reponse = await fetch("/api/voix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texte: $("phrase").value }),
    });
    const donnees = await reponse.json();
    if (!reponse.ok || !donnees.audio) throw new Error(donnees.erreur ?? "Aucun son reçu.");
    enLecture = jouerTampon(ctx, await decoderBase64(ctx, donnees.audio));
    $("resultat-voix").textContent = `Fabriquée en ${donnees.duree} ms. Texte lu : ${donnees.prononce}`;
  } catch (erreur) {
    $("resultat-voix").textContent = erreur.message;
  }
});

$("voix-telephone").addEventListener("click", () => {
  enLecture?.arreter();
  enLecture = parlerNavigateur($("phrase").value);
  $("resultat-voix").textContent = "Voix intégrée à ce téléphone : aucun coût, mais elle change d'un appareil à l'autre.";
});

$("micro").addEventListener("click", async () => {
  const ctx = audio();
  const bouton = $("micro");
  bouton.disabled = true;
  bouton.textContent = "Je vous écoute…";
  $("transcription").textContent = "";
  $("resultat-micro").textContent = "";
  let micro = null;
  const terminer = () => {
    micro?.fermer();
    bouton.disabled = false;
    bouton.textContent = "Parler";
  };
  try {
    let detecteur = null;
    micro = await ouvrirMicro(ctx, (trame) => detecteur?.trame(trame));
    detecteur = new DetecteurParole(ctx.sampleRate, {
      surFin: async (prise) => {
        const wav = priseEnWavBase64(prise, ctx.sampleRate);
        detecteur = null;
        terminer();
        $("resultat-micro").textContent = "Transcription…";
        const reponse = await fetch("/api/tour", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audio: wav, mode: "transcription" }),
        });
        const lignes = (await reponse.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const texte = lignes.find((l) => l.t === "transcription")?.texte;
        const fin = lignes.find((l) => l.mesures)?.mesures;
        $("transcription").textContent = texte ?? "";
        $("resultat-micro").textContent = texte
          ? `Transcrit en ${fin?.transcription ?? "?"} ms.`
          : "Rien de compréhensible. Rapproche-toi du micro et réessaie.";
      },
    });
  } catch {
    terminer();
    $("resultat-micro").textContent = "Le micro n'est pas autorisé sur cette page.";
  }
});
