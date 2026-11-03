import {
  DetecteurParole,
  decoderBase64,
  jouerTampon,
  ouvrirMicro,
  parlerNavigateur,
  priseEnWavBase64,
  texteConsommation,
} from "/audio.js";

const $ = (id) => document.getElementById(id);
let contexte = null;
let enLecture = null;

function audio() {
  contexte ??= new (window.AudioContext || window.webkitAudioContext)();
  contexte.resume();
  return contexte;
}

const EXEMPLES = {
  fr: [
    "Trinocle Film produit des vidéos interactives pour les entreprises.",
    "Un projet se déroule en 8 semaines, de la conception à la post-production.",
    "Les élèves ont écouté une histoire, puis ils ont répondu à voix haute : quelle est votre réponse ?",
    "Avec un panier moyen de 300 € et 30 % de conversion perdue, le retour sur investissement se calcule vite.",
  ],
  en: [
    "Trinocle Film creates interactive videos for businesses.",
    "A project takes 8 weeks, from concept to post-production.",
    "With an average basket of 300 € and 30 % of lost conversions, the return on investment adds up quickly.",
  ],
  zh: [
    "Trinocle Film 为企业制作互动视频。",
    "一个项目从构思到后期制作，大约需要八周。",
    "观众不再只是观看，而是参与自己的决定。",
  ],
};
const NOMS_LANGUES = { fr: "français", en: "anglais", zh: "chinois" };

function remplirExemples() {
  const langue = $("langue").value;
  $("modele").replaceChildren(...EXEMPLES[langue].map((texte) => new Option(texte, texte)));
  $("phrase").value = $("modele").value;
  $("phrase").lang = langue === "zh" ? "zh-CN" : langue;
}
remplirExemples();
$("langue").addEventListener("change", remplirExemples);
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
      body: JSON.stringify({ texte: $("phrase").value, langue: $("langue").value }),
    });
    const donnees = await reponse.json();
    if (!reponse.ok || !donnees.audio) throw new Error(`${donnees.erreur ?? "Aucun son reçu."}${donnees.detail ? ` [${donnees.detail}]` : ""}`);
    enLecture = jouerTampon(ctx, await decoderBase64(ctx, donnees.audio));
    $("resultat-voix").textContent = `Fabriquée en ${donnees.duree} ms. Texte lu : ${donnees.prononce}\n${texteConsommation(donnees.conso, { parJour: false })}`;
  } catch (erreur) {
    $("resultat-voix").textContent = erreur.message;
  }
});

$("voix-telephone").addEventListener("click", () => {
  enLecture?.arreter();
  enLecture = parlerNavigateur($("phrase").value, $("langue").value);
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
        const ligne = lignes.find((l) => l.t === "transcription");
        const texte = ligne?.texte;
        const mesures = lignes.find((l) => l.mesures)?.mesures;
        $("transcription").textContent = texte ?? "";
        $("transcription").lang = ligne?.langue === "zh" ? "zh-CN" : (ligne?.langue ?? "fr");
        etat.textContent = texte
          ? `Transcrit en ${mesures?.transcription ?? "?"} ms. Langue détectée : ${NOMS_LANGUES[ligne.langue] ?? "?"}.\n${texteConsommation(mesures?.conso, { parJour: false })}`
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
