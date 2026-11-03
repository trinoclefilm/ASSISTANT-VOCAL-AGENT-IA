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

$("diagnostic").addEventListener("click", async () => {
  const bouton = $("diagnostic");
  bouton.disabled = true;
  $("resultat-diagnostic").textContent = "Vérification en cours…";
  try {
    const reponse = await fetch("/api/diagnostic", { method: "POST" });
    const donnees = await reponse.json();
    if (!reponse.ok) throw new Error(donnees.erreur ?? `Erreur ${reponse.status}`);
    $("resultat-diagnostic").textContent = donnees.etapes
      .map((e) => (e.ok ? `✔ ${e.nom} : ${e.ms} ms` : `✘ ${e.nom} : ${e.detail}`))
      .join("\n");
  } catch (erreur) {
    $("resultat-diagnostic").textContent = `Le serveur ne répond pas : ${erreur.message}`;
  } finally {
    bouton.disabled = false;
  }
});

let prise = null;

$("micro").addEventListener("click", async () => {
  // Deuxième touche pendant l'écoute : on termine la prise à la main.
  if (prise) {
    prise.detecteur?.terminer();
    if (prise.detecteur && !prise.detecteur.enParole) prise.fin("Je n'ai rien entendu. Vérifie que le micro est autorisé, puis réessaie.");
    return;
  }

  const ctx = audio();
  const bouton = $("micro");
  const etat = $("resultat-micro");
  $("transcription").textContent = "";
  etat.textContent = "Ouverture du micro…";
  let micro = null;
  let minuteur = null;
  let affichage = null;
  const courante = { detecteur: null };
  const fin = (message) => {
    clearTimeout(minuteur);
    clearInterval(affichage);
    micro?.fermer();
    prise = null;
    bouton.textContent = "Parler";
    if (message) etat.textContent = message;
  };
  courante.fin = fin;
  prise = courante;

  try {
    micro = await ouvrirMicro(ctx, (trame) => courante.detecteur?.trame(trame));
  } catch (erreur) {
    fin(`Le micro n'a pas pu s'ouvrir (${erreur.name ?? "erreur"}). Autorise-le dans les réglages du navigateur pour ce site.`);
    return;
  }

  bouton.textContent = "Terminer";
  courante.detecteur = new DetecteurParole(ctx.sampleRate, {
    surFin: async (enregistrement) => {
      courante.detecteur = null;
      fin("Transcription…");
      try {
        const wav = priseEnWavBase64(enregistrement, ctx.sampleRate);
        const reponse = await fetch("/api/tour", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audio: wav, mode: "transcription" }),
        });
        const brut = await reponse.text();
        if (!reponse.ok) {
          let motif = `erreur ${reponse.status}`;
          try {
            motif = JSON.parse(brut).erreur ?? motif;
          } catch {
            // Réponse qui n'est pas du JSON : on garde le code.
          }
          throw new Error(motif);
        }
        const lignes = brut.split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const probleme = lignes.find((l) => l.t === "erreur");
        if (probleme) throw new Error(`${probleme.texte}${probleme.detail ? ` [${probleme.detail}]` : ""}`);
        const texte = lignes.find((l) => l.t === "transcription")?.texte;
        const duree = lignes.find((l) => l.mesures)?.mesures?.transcription;
        $("transcription").textContent = texte ?? "";
        etat.textContent = texte
          ? `Transcrit en ${duree ?? "?"} ms.`
          : "J'ai entendu un son, mais pas de paroles claires. Rapproche-toi du micro et réessaie.";
      } catch (erreur) {
        etat.textContent = `Échec : ${erreur.message}`;
      }
    },
  });

  // Retour visuel : on voit si le micro capte, même avant que la parole soit détectée.
  affichage = setInterval(() => {
    const d = courante.detecteur;
    if (!d) return;
    const barres = "▮".repeat(Math.round(d.niveau * 10)).padEnd(10, "▯");
    etat.textContent = d.enParole ? `Je t'écoute… ${barres}` : `Parle maintenant… ${barres}`;
  }, 120);
  minuteur = setTimeout(() => {
    if (courante.detecteur && !courante.detecteur.enParole) fin("Je n'ai rien entendu en 10 secondes. Le micro est peut-être coupé ou bloqué.");
  }, 10000);
});
