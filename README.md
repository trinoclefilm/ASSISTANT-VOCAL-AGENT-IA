# Assistant vocal Trinocle Film

Un agent vocal qui répond aux questions sur les vidéos interactives de Trinocle Film, en français, en anglais ou en chinois. Il tourne sur Cloudflare Workers, sans abonnement, et s'intègre par-dessus une vidéo.

La personne parle, Whisper transcrit et reconnaît la langue, Mistral répond dans cette langue à partir de `src/connaissances.js`, MeloTTS lit la réponse phrase par phrase. Rien n'est stocké.

## Mettre en ligne depuis un téléphone

Aucun ordinateur, aucune clé secrète, aucune carte bancaire.

1. Sur [dash.cloudflare.com](https://dash.cloudflare.com), ouvre **Workers & Pages**, puis **Create application**, puis **GitHub**.
2. Choisis le dépôt `ASSISTANT-VOCAL-AGENT-IA`. S'il n'apparaît pas, ouvre [les réglages de l'application Cloudflare sur GitHub](https://github.com/settings/installations) et donne-lui accès à ce dépôt.
3. Garde le nom proposé, `assistant-vocal-agent-ia` : il doit être identique à celui de `wrangler.jsonc`, sinon la mise en ligne échoue. Touche **Save and Deploy**, puis attends une à deux minutes.
4. Ouvre l'adresse `.workers.dev` affichée, en ajoutant `/test.html` à la fin pour le test de voix.

Autre possibilité : [le bouton de déploiement](https://deploy.workers.cloudflare.com/?url=https://github.com/trinoclefilm/ASSISTANT-VOCAL-AGENT-IA). Il crée une copie du dépôt dans ton compte GitHub : il faudra ensuite modifier cette copie, et lui donner un autre nom que l'original.

## Changer ce que dit l'assistant

Tout est dans [`src/connaissances.js`](src/connaissances.js) : l'introduction, ta base de connaissances, les règles de l'assistant et la prononciation des mots difficiles. Touche le crayon sur GitHub, modifie, enregistre : Cloudflare remet l'agent en ligne tout seul.

Ce dépôt est public. N'y écris rien de confidentiel.

## Pages

| Adresse | Rôle |
| --- | --- |
| `/` | L'assistant |
| `/test.html` | Vérifier les modèles, écouter les voix française, anglaise et chinoise, tester la transcription |
| `/?mesures` | Conversation avec le temps de réponse, la langue reconnue et la consommation de chaque échange |
| `/?voix=navigateur` | Conversation avec la voix du téléphone au lieu de MeloTTS |
| `/?integre` | Version compacte pour un cadre par-dessus une vidéo |

## Langues

Whisper reconnaît seul la langue parlée. L'agent répond et parle dans cette langue, et la retient pour la suite de la conversation. Si Whisper hésite (moins de 50 % de certitude, par exemple un fort accent), l'agent garde la langue de la conversation et refait la transcription dans cette langue. Une question écrite est classée d'après ses mots.

| Langue | Comprise | Réponse | Voix Cloudflare | Voix du téléphone |
| --- | --- | --- | --- | --- |
| Français | oui | oui | oui | `fr-FR` |
| Anglais | oui | oui | oui | `en-US` |
| Chinois mandarin | oui | oui, en caractères simplifiés | à vérifier avec `/test.html` | `zh-CN` |

Si Cloudflare refuse une voix, la phrase est lue par la voix du téléphone. Restent en français : l'introduction, les boutons et les cartes (prix, déroulé, exemples). Pour ajouter une langue, voir `LANGUES` dans [`src/voix.js`](src/voix.js) (MeloTTS sait aussi dire l'espagnol, le japonais et le coréen).

## Intégrer dans une vidéo

```html
<iframe src="https://VOTRE-ADRESSE.workers.dev/?integre"
  allow="microphone; autoplay"
  style="width:100%;height:420px;border:0"
  title="Assistant vocal"></iframe>
```

Pour que la vidéo réagisse, la page qui contient le cadre écoute ce que dit l'agent :

```js
window.addEventListener("message", (e) => {
  if (e.data?.source !== "trinocle-voix") return;
  // e.data.type : "etat" | "transcription" | "intention" | "reponse"
  // e.data.langue : "fr" | "en" | "zh" (avec "transcription")
  // e.data.intention : "prix" | "rdv" | "exemples" | "deroule" | "garantie" | "automation" | "histoire"
  // e.data.texte : ce que la personne a dit, ou ce que l'assistant a répondu
  if (e.data.intention === "exemples") lecteur.allerAuChapitre("exemples");
});
```

`lecteur.allerAuChapitre` est un exemple : remplace-le par la commande de ton lecteur vidéo.

## Ce que consomme une réponse

Cloudflare compte en neurones. Le plan gratuit en donne 10 000 par jour, puis refuse les demandes sans rien facturer. Prix relevés sur [la grille Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) en novembre 2026.

| Étape | Modèle | Tarif | Pour un échange type |
| --- | --- | --- | --- |
| Voix vers texte | `@cf/openai/whisper-large-v3-turbo` | 46,63 neurones par minute de question | 4 s de question : environ 3 |
| Réponse | `@cf/mistralai/mistral-small-3.1-24b-instruct` | 31 876 par million de jetons lus, 50 488 par million écrits | 2 000 à 2 600 jetons lus, 60 à 100 écrits : 65 à 85 |
| Texte vers voix | `@cf/myshell-ai/melotts` | 18,63 par minute de voix produite | 15 s de réponse : environ 5 |

Total : environ 75 à 95 neurones par échange, soit une centaine d'échanges gratuits par jour. Avec `?voix=navigateur`, la voix ne coûte rien.

Le modèle relit toutes les consignes et toute la base de connaissances (environ 1 900 jetons) à chaque question : c'est 85 % de la consommation. Raccourcir `BASE` dans `src/connaissances.js` est donc le moyen le plus efficace de payer moins.

Le reste est négligeable : l'introduction est fabriquée une fois par jour puis gardée en cache (environ 9 neurones), une vérification sur `/test.html` coûte environ 2 neurones, et chaque échange ne compte que pour une demande sur les 100 000 que le plan gratuit Workers autorise par jour.

Les vrais chiffres s'affichent après chaque réponse avec `/?mesures` : neurones par étape, jetons lus et écrits, et nombre d'échanges gratuits par jour à ce rythme.

Au-delà du gratuit, le plan Workers Paid coûte 5 $ par mois, plus 0,011 $ les 1 000 neurones, soit environ 0,1 centime par échange.

## Pourquoi pas le kit officiel `@cloudflare/voice`

Le kit garde le micro ouvert en continu, et son modèle français possible (Nova-3 en WebSocket) coûte 836 neurones par minute de micro ouvert, soit une douzaine de minutes par jour sur le plan gratuit. Sa voix par défaut, Aura-1, est anglaise, et Cloudflare ne propose Aura-2 qu'en anglais et en espagnol. Ici, seule la parole utile est envoyée et facturée. Le prix à payer est une réponse tour par tour : on interrompt l'assistant en touchant l'objectif, pas en lui parlant dessus.

## Tests

```sh
npm test
```

Les tests couvrent le texte : nombres, prononciation, langues, découpage des phrases (y compris en chinois), phrases inventées par Whisper sur du silence, durée des voix et calcul de la consommation. Le parcours complet a été vérifié dans un navigateur avec un micro et des modèles simulés. La qualité réelle des modèles se vérifie en ligne, avec `/test.html`.

Polices : Fraunces et IBM Plex Sans, sous licence SIL Open Font, hébergées ici pour ne rien charger depuis un service tiers.
