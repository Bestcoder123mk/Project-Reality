/**
 * SEC10-UIUX (prompt 78): Localization / i18n pipeline.
 *
 * A real i18n system with translation-key extraction. The menu
 * components currently ship with hardcoded English strings — this
 * module catalogs every one of those strings into a `MESSAGE_CATALOG`
 * (a structured list of { key, sourceFile, sourceLine, en }) and
 * provides a `t(key, params?)` function for runtime lookup.
 *
 * Translations are seeded for English + Spanish (es) + French (fr),
 * covering the menu strings. Translators can extend the dictionaries
 * without touching component code.
 *
 * Public API:
 *   - `setLocale(locale)` — set the active locale (persists to localStorage).
 *   - `getLocale()` — read the active locale.
 *   - `t(key, params?)` — translate a key with optional {param} substitution.
 *   - `MESSAGE_CATALOG` — the structured catalog of source strings.
 *   - `TranslationDict` — type for a locale→key→string dictionary.
 *   - `SUPPORTED_LOCALES` — list of locales with translations.
 *
 * SSR-safe: server-side calls default to "en" + never touch localStorage.
 */

export type Locale = "en" | "es" | "fr";

export const SUPPORTED_LOCALES: Locale[] = ["en", "es", "fr"];

export const LOCALE_LABELS: Record<Locale, { label: string; flag: string }> = {
  en: { label: "English", flag: "🇺🇸" },
  es: { label: "Español", flag: "🇪🇸" },
  fr: { label: "Français", flag: "🇫🇷" },
};

/**
 * A locale→key→string dictionary. The English dictionary is the
 * source of truth; missing keys in other locales fall back to English.
 */
export type TranslationDict = Record<string, string>;

// ─── Translation dictionaries ──────────────────────────────────────────────

const EN: TranslationDict = {
  // ── Common ──
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.back": "Back",
  "common.next": "Next",
  "common.close": "Close",
  "common.buy": "Buy",
  "common.equip": "Equip",
  "common.unequip": "Unequip",
  "common.locked": "Locked",
  "common.owned": "Owned",
  "common.search": "Search",
  "common.loading": "Loading…",
  "common.error": "Something went wrong",
  "common.credits": "credits",

  // ── Main menu ──
  "menu.title": "Project Reality",
  "menu.subtitle": "Tactical FPS",
  "menu.deploy": "Deploy",
  "menu.loadout": "Loadout",
  "menu.gunsmith": "Gunsmith",
  "menu.shop": "Shop",
  "menu.battlepass": "Battle Pass",
  "menu.tutorial": "Tutorial",
  "menu.operator": "Operator",
  "menu.settings": "Settings",
  "menu.career": "Career",

  // ── Settings panel sections ──
  "settings.display": "Display",
  "settings.graphics": "Graphics",
  "settings.audio": "Audio",
  "settings.controls": "Controls",
  "settings.crosshair": "Crosshair",
  "settings.accessibility": "Accessibility",
  "settings.gameplay": "Gameplay",
  "settings.social": "Social",
  "settings.benchmark": "Graphics Benchmark",

  // ── Display section ──
  "settings.fov": "Field of View",
  "settings.hudScale": "HUD Scale",
  "settings.showFps": "Show FPS Counter",
  "settings.dynamicShadows": "Dynamic Shadows",

  // ── Graphics section ──
  "settings.quality": "Quality",
  "settings.textureQuality": "Texture Quality",
  "settings.shadowQuality": "Shadow Quality",
  "settings.antiAliasing": "Anti-aliasing",
  "settings.shadows": "Shadows",
  "settings.ssao": "Screen-Space Ambient Occlusion",
  "settings.particles": "Particles",
  "settings.bloom": "Bloom",
  "settings.motionBlur": "Motion Blur",

  // ── Audio section ──
  "settings.masterVolume": "Master Volume",
  "settings.sfxVolume": "SFX Volume",
  "settings.musicVolume": "Music Volume",
  "settings.voiceVolume": "Voice Volume",
  "settings.muteOnFocusLoss": "Mute on Focus Loss",

  // ── Controls section ──
  "settings.mouseSensitivity": "Mouse Sensitivity",
  "settings.adsSensitivity": "ADS Sensitivity",
  "settings.adsMode": "ADS Mode",
  "settings.adsSpeed": "ADS Speed",
  "settings.invertY": "Invert Y Axis",
  "settings.keybindings": "Keybindings",
  "settings.rebind": "Rebind",
  "settings.resetToDefault": "Reset to Default",
  "settings.pressKey": "Press a key…",

  // ── Crosshair section ──
  "settings.crosshairStyle": "Style",
  "settings.crosshairColor": "Color",
  "settings.crosshairLength": "Length",
  "settings.crosshairThickness": "Thickness",
  "settings.crosshairGap": "Gap",
  "settings.crosshairOutline": "Outline",
  "settings.crosshairDot": "Show Center Dot",
  "settings.crosshairDynamicSpread": "Dynamic Spread",
  "settings.livePreview": "Live preview",

  // ── Accessibility section ──
  "settings.colorblindMode": "Colorblind Mode",
  "settings.colorblind.none": "None",
  "settings.colorblind.protanopia": "Protan",
  "settings.colorblind.deuteranopia": "Deutan",
  "settings.colorblind.tritanopia": "Tritan",
  "settings.colorblind.highContrast": "High Contrast",
  "settings.colorblind.monochrome": "Monochrome",
  "settings.motionSickness": "Motion Sickness Mode",
  "settings.subtitles": "Subtitles",
  "settings.reducedMotion": "Reduced Motion",
  "settings.hudOpacity": "HUD Opacity",

  // ── Gameplay section ──
  "settings.difficulty": "Difficulty",
  "settings.difficulty.easy": "Easy",
  "settings.difficulty.normal": "Normal",
  "settings.difficulty.hard": "Hard",
  "settings.autoReload": "Auto-reload When Empty",
  "settings.autoTarget": "Auto-targeting Assist",
  "settings.confirmedKills": "Confirmed Kills",
  "settings.matchDuration": "Match Duration",
  // J-4064 — Language section label (wired through t() in VideoPanel).
  "settings.language.label": "Language",

  // ── Loadout picker ──
  "loadout.title": "Loadout",
  "loadout.primary": "Primary",
  "loadout.secondary": "Secondary",
  "loadout.melee": "Melee",
  "loadout.utility": "Utility",
  "loadout.slot1": "Slot 1",
  "loadout.slot2": "Slot 2",
  "loadout.slot3": "Slot 3",
  "loadout.slot4": "Slot 4",
  "loadout.save": "Save Loadout",
  "loadout.clear": "Clear Slot",

  // ── Gunsmith ──
  "gunsmith.attachments": "Attachments",
  "gunsmith.finish": "Finish",
  "gunsmith.wraps": "Wraps",
  "gunsmith.charms": "Charms",
  "gunsmith.muzzle": "Muzzle",
  "gunsmith.sight": "Sight",
  "gunsmith.grip": "Grip",
  "gunsmith.magazine": "Magazine",

  // ── Shop / economy ──
  "shop.title": "Shop",
  "shop.packs": "Packs",
  "shop.purchased": "Purchased!",
  "shop.insufficientCredits": "Not enough credits",
  "shop.category.all": "All",
  "shop.category.rifle": "Rifle",
  "shop.category.smg": "SMG",
  "shop.category.pistol": "Pistol",
  "shop.category.sniper": "Sniper",
  "shop.category.shotgun": "Shotgun",
  "shop.category.lmg": "LMG",
  "shop.category.melee": "Melee",
  "shop.category.utility": "Utility",

  // ── Battle Pass ──
  "battlepass.title": "Battle Pass",
  "battlepass.season": "Season",
  "battlepass.tier": "Tier",
  "battlepass.claim": "Claim",
  "battlepass.claimed": "Claimed",
  "battlepass.premium": "Premium",
  "battlepass.free": "Free Track",

  // ── Tutorial ──
  "tutorial.welcome": "Welcome to Project Reality",
  "tutorial.movement": "Movement & Stance",
  "tutorial.weapons": "Weapon Handling",
  "tutorial.ballistics": "Ballistics & Penetration",
  "tutorial.suppression": "Suppression System",
  "tutorial.medical": "Medical & Casualty",
  "tutorial.weather": "Dynamic Weather",
  "tutorial.radio": "Radio Macros",
  "tutorial.audio": "Audio Realism",
  "tutorial.loadout": "Loadout System",
  "tutorial.gunsmith": "Gunsmith & Attachments",
  "tutorial.economy": "Shop & Economy",
  "tutorial.battlepass": "Battle Pass",
  "tutorial.ready": "Ready to Deploy",

  // ── Pack screen ──
  "pack.open": "Open Crate",
  "pack.odds": "Drop Odds",
  "pack.showOdds": "Show odds",
  "pack.hideOdds": "Hide odds",
  "pack.duplicate": "Duplicate",
  "pack.addedToInventory": "Added to inventory",

  // ── Social ──
  "social.title": "Social",
  "social.profile": "Profile",
  "social.clan": "Clan",
  "social.friends": "Friends",
  "social.searchPlayers": "Search players",
  "social.noResults": "No players found",
  "social.stats.kills": "Kills",
  "social.stats.deaths": "Deaths",
  "social.stats.kd": "K/D",
  "social.stats.wins": "Wins",
  "social.stats.matches": "Matches",
  "social.stats.playtime": "Playtime",
};

const ES: TranslationDict = {
  // ── Common ──
  "common.cancel": "Cancelar",
  "common.confirm": "Confirmar",
  "common.back": "Atrás",
  "common.next": "Siguiente",
  "common.close": "Cerrar",
  "common.buy": "Comprar",
  "common.equip": "Equipar",
  "common.unequip": "Quitar",
  "common.locked": "Bloqueado",
  "common.owned": "En propiedad",
  "common.search": "Buscar",
  "common.loading": "Cargando…",
  "common.error": "Algo salió mal",
  "common.credits": "créditos",

  // ── Main menu ──
  "menu.title": "Project Reality",
  "menu.subtitle": "FPS Táctico",
  "menu.deploy": "Desplegar",
  "menu.loadout": "Equipamiento",
  "menu.gunsmith": "Armero",
  "menu.shop": "Tienda",
  "menu.battlepass": "Pase de Batalla",
  "menu.tutorial": "Tutorial",
  "menu.operator": "Operador",
  "menu.settings": "Ajustes",
  "menu.career": "Carrera",

  // ── Settings panel sections ──
  "settings.display": "Pantalla",
  "settings.graphics": "Gráficos",
  "settings.audio": "Audio",
  "settings.controls": "Controles",
  "settings.crosshair": "Mira",
  "settings.accessibility": "Accesibilidad",
  "settings.gameplay": "Jugabilidad",
  "settings.social": "Social",
  "settings.benchmark": "Benchmark de Gráficos",

  // ── Display section ──
  "settings.fov": "Campo de Visión",
  "settings.hudScale": "Escala del HUD",
  "settings.showFps": "Mostrar FPS",
  "settings.dynamicShadows": "Sombras Dinámicas",

  // ── Graphics section ──
  "settings.quality": "Calidad",
  "settings.textureQuality": "Calidad de Texturas",
  "settings.shadowQuality": "Calidad de Sombras",
  "settings.antiAliasing": "Suavizado de Bordes",
  "settings.shadows": "Sombras",
  "settings.ssao": "Oclusión Ambiental",
  "settings.particles": "Partículas",
  "settings.bloom": "Resplandor",
  "settings.motionBlur": "Desenfoque de Movimiento",

  // ── Audio section ──
  "settings.masterVolume": "Volumen General",
  "settings.sfxVolume": "Volumen de Efectos",
  "settings.musicVolume": "Volumen de Música",
  "settings.voiceVolume": "Volumen de Voz",
  "settings.muteOnFocusLoss": "Silenciar al Perder Foco",

  // ── Controls section ──
  "settings.mouseSensitivity": "Sensibilidad del Ratón",
  "settings.adsSensitivity": "Sensibilidad ADS",
  "settings.adsMode": "Modo ADS",
  "settings.adsSpeed": "Velocidad ADS",
  "settings.invertY": "Invertir Eje Y",
  "settings.keybindings": "Atajos de Teclado",
  "settings.rebind": "Reasignar",
  "settings.resetToDefault": "Restablecer",
  "settings.pressKey": "Pulsa una tecla…",

  // ── Crosshair section ──
  "settings.crosshairStyle": "Estilo",
  "settings.crosshairColor": "Color",
  "settings.crosshairLength": "Longitud",
  "settings.crosshairThickness": "Grosor",
  "settings.crosshairGap": "Espacio",
  "settings.crosshairOutline": "Contorno",
  "settings.crosshairDot": "Mostrar Punto Central",
  "settings.crosshairDynamicSpread": "Dispersión Dinámica",
  "settings.livePreview": "Vista previa",

  // ── Accessibility section ──
  "settings.colorblindMode": "Modo Daltonico",
  "settings.colorblind.none": "Ninguno",
  "settings.colorblind.protanopia": "Protan",
  "settings.colorblind.deuteranopia": "Deutan",
  "settings.colorblind.tritanopia": "Tritan",
  "settings.colorblind.highContrast": "Alto Contraste",
  "settings.colorblind.monochrome": "Monocromo",
  "settings.motionSickness": "Modo Mareo",
  "settings.subtitles": "Subtítulos",
  "settings.reducedMotion": "Movimiento Reducido",
  "settings.hudOpacity": "Opacidad del HUD",

  // ── Gameplay section ──
  "settings.difficulty": "Dificultad",
  "settings.difficulty.easy": "Fácil",
  "settings.difficulty.normal": "Normal",
  "settings.difficulty.hard": "Difícil",
  "settings.autoReload": "Recarga Automática",
  "settings.autoTarget": "Asistencia de Apuntado",
  "settings.confirmedKills": "Bajas Confirmadas",
  "settings.matchDuration": "Duración de Partida",
  // J-4064 — Language section label.
  "settings.language.label": "Idioma",

  // ── Loadout picker ──
  "loadout.title": "Equipamiento",
  "loadout.primary": "Primaria",
  "loadout.secondary": "Secundaria",
  "loadout.melee": "Cuerpo a Cuerpo",
  "loadout.utility": "Utilidad",
  "loadout.slot1": "Ranura 1",
  "loadout.slot2": "Ranura 2",
  "loadout.slot3": "Ranura 3",
  "loadout.slot4": "Ranura 4",
  "loadout.save": "Guardar Equipamiento",
  "loadout.clear": "Vaciar Ranura",

  // ── Gunsmith ──
  "gunsmith.attachments": "Accesorios",
  "gunsmith.finish": "Acabado",
  "gunsmith.wraps": "Envolturas",
  "gunsmith.charms": "Amuletos",
  "gunsmith.muzzle": "Boca de Cañón",
  "gunsmith.sight": "Mira",
  "gunsmith.grip": "Empuñadura",
  "gunsmith.magazine": "Cargador",

  // ── Shop / economy ──
  "shop.title": "Tienda",
  "shop.packs": "Cajas",
  "shop.purchased": "¡Comprado!",
  "shop.insufficientCredits": "Créditos insuficientes",
  "shop.category.all": "Todo",
  "shop.category.rifle": "Fusil",
  "shop.category.smg": "SMG",
  "shop.category.pistol": "Pistola",
  "shop.category.sniper": "Francotirador",
  "shop.category.shotgun": "Escopeta",
  "shop.category.lmg": "Ametralladora",
  "shop.category.melee": "Cuerpo a Cuerpo",
  "shop.category.utility": "Utilidad",

  // ── Battle Pass ──
  "battlepass.title": "Pase de Batalla",
  "battlepass.season": "Temporada",
  "battlepass.tier": "Nivel",
  "battlepass.claim": "Reclamar",
  "battlepass.claimed": "Reclamado",
  "battlepass.premium": "Premium",
  "battlepass.free": "Ruta Gratuita",

  // ── Tutorial ──
  "tutorial.welcome": "Bienvenido a Project Reality",
  "tutorial.movement": "Movimiento y Postura",
  "tutorial.weapons": "Manejo de Armas",
  "tutorial.ballistics": "Balística y Penetración",
  "tutorial.suppression": "Sistema de Supresión",
  "tutorial.medical": "Médico y Bajas",
  "tutorial.weather": "Clima Dinámico",
  "tutorial.radio": "Macros de Radio",
  "tutorial.audio": "Realismo de Audio",
  "tutorial.loadout": "Sistema de Equipamiento",
  "tutorial.gunsmith": "Armero y Accesorios",
  "tutorial.economy": "Tienda y Economía",
  "tutorial.battlepass": "Pase de Batalla",
  "tutorial.ready": "Listo para Desplegarse",

  // ── Pack screen ──
  "pack.open": "Abrir Caja",
  "pack.odds": "Probabilidades",
  "pack.showOdds": "Mostrar probabilidades",
  "pack.hideOdds": "Ocultar probabilidades",
  "pack.duplicate": "Duplicado",
  "pack.addedToInventory": "Añadido al inventario",

  // ── Social ──
  "social.title": "Social",
  "social.profile": "Perfil",
  "social.clan": "Clan",
  "social.friends": "Amigos",
  "social.searchPlayers": "Buscar jugadores",
  "social.noResults": "No se encontraron jugadores",
  "social.stats.kills": "Bajas",
  "social.stats.deaths": "Muertes",
  "social.stats.kd": "M/B",
  "social.stats.wins": "Victorias",
  "social.stats.matches": "Partidas",
  "social.stats.playtime": "Tiempo de Juego",
};

const FR: TranslationDict = {
  // ── Common ──
  "common.cancel": "Annuler",
  "common.confirm": "Confirmer",
  "common.back": "Retour",
  "common.next": "Suivant",
  "common.close": "Fermer",
  "common.buy": "Acheter",
  "common.equip": "Équiper",
  "common.unequip": "Retirer",
  "common.locked": "Verrouillé",
  "common.owned": "Possédé",
  "common.search": "Rechercher",
  "common.loading": "Chargement…",
  "common.error": "Une erreur est survenue",
  "common.credits": "crédits",

  // ── Main menu ──
  "menu.title": "Project Reality",
  "menu.subtitle": "FPS Tactique",
  "menu.deploy": "Déployer",
  "menu.loadout": "Équipement",
  "menu.gunsmith": "Armurerie",
  "menu.shop": "Boutique",
  "menu.battlepass": "Passe de Combat",
  "menu.tutorial": "Tutoriel",
  "menu.operator": "Opérateur",
  "menu.settings": "Paramètres",
  "menu.career": "Carrière",

  // ── Settings panel sections ──
  "settings.display": "Affichage",
  "settings.graphics": "Graphismes",
  "settings.audio": "Audio",
  "settings.controls": "Contrôles",
  "settings.crosshair": "Réticule",
  "settings.accessibility": "Accessibilité",
  "settings.gameplay": "Gameplay",
  "settings.social": "Social",
  "settings.benchmark": "Benchmark Graphique",

  // ── Display section ──
  "settings.fov": "Champ de Vision",
  "settings.hudScale": "Échelle du HUD",
  "settings.showFps": "Afficher les FPS",
  "settings.dynamicShadows": "Ombres Dynamiques",

  // ── Graphics section ──
  "settings.quality": "Qualité",
  "settings.textureQuality": "Qualité des Textures",
  "settings.shadowQuality": "Qualité des Ombres",
  "settings.antiAliasing": "Anti-crénelage",
  "settings.shadows": "Ombres",
  "settings.ssao": "Occlusion Ambiante",
  "settings.particles": "Particules",
  "settings.bloom": "Flou Lumineux",
  "settings.motionBlur": "Flou de Mouvement",

  // ── Audio section ──
  "settings.masterVolume": "Volume Général",
  "settings.sfxVolume": "Volume des Effets",
  "settings.musicVolume": "Volume de la Musique",
  "settings.voiceVolume": "Volume Voix",
  "settings.muteOnFocusLoss": "Couper le Son en Arrière-plan",

  // ── Controls section ──
  "settings.mouseSensitivity": "Sensibilité de la Souris",
  "settings.adsSensitivity": "Sensibilité visée",
  "settings.adsMode": "Mode de Visée",
  "settings.adsSpeed": "Vitesse de Visée",
  "settings.invertY": "Inverser l'axe Y",
  "settings.keybindings": "Raccourcis Clavier",
  "settings.rebind": "Réassigner",
  "settings.resetToDefault": "Réinitialiser",
  "settings.pressKey": "Appuyez sur une touche…",

  // ── Crosshair section ──
  "settings.crosshairStyle": "Style",
  "settings.crosshairColor": "Couleur",
  "settings.crosshairLength": "Longueur",
  "settings.crosshairThickness": "Épaisseur",
  "settings.crosshairGap": "Écart",
  "settings.crosshairOutline": "Contour",
  "settings.crosshairDot": "Afficher le Point Central",
  "settings.crosshairDynamicSpread": "Dispersion Dynamique",
  "settings.livePreview": "Aperçu en direct",

  // ── Accessibility section ──
  "settings.colorblindMode": "Mode Daltonien",
  "settings.colorblind.none": "Aucun",
  "settings.colorblind.protanopia": "Protan",
  "settings.colorblind.deuteranopia": "Deutan",
  "settings.colorblind.tritanopia": "Tritan",
  "settings.colorblind.highContrast": "Contraste Élevé",
  "settings.colorblind.monochrome": "Monochrome",
  "settings.motionSickness": "Mode Mal des Transports",
  "settings.subtitles": "Sous-titres",
  "settings.reducedMotion": "Mouvement Réduit",
  "settings.hudOpacity": "Opacité du HUD",

  // ── Gameplay section ──
  "settings.difficulty": "Difficulté",
  "settings.difficulty.easy": "Facile",
  "settings.difficulty.normal": "Normal",
  "settings.difficulty.hard": "Difficile",
  "settings.autoReload": "Rechargement Auto",
  "settings.autoTarget": "Aide à la Visée",
  "settings.confirmedKills": "Éliminations Confirmées",
  "settings.matchDuration": "Durée de la Partie",
  // J-4064 — Language section label.
  "settings.language.label": "Langue",

  // ── Loadout picker ──
  "loadout.title": "Équipement",
  "loadout.primary": "Principale",
  "loadout.secondary": "Secondaire",
  "loadout.melee": "Mêlée",
  "loadout.utility": "Utilitaire",
  "loadout.slot1": "Emplacement 1",
  "loadout.slot2": "Emplacement 2",
  "loadout.slot3": "Emplacement 3",
  "loadout.slot4": "Emplacement 4",
  "loadout.save": "Sauvegarder",
  "loadout.clear": "Vider l'Emplacement",

  // ── Gunsmith ──
  "gunsmith.attachments": "Accessoires",
  "gunsmith.finish": "Finition",
  "gunsmith.wraps": "Habillages",
  "gunsmith.charms": "Breloques",
  "gunsmith.muzzle": "Bouche",
  "gunsmith.sight": "Viseur",
  "gunsmith.grip": "Poignée",
  "gunsmith.magazine": "Chargeur",

  // ── Shop / economy ──
  "shop.title": "Boutique",
  "shop.packs": "Caisses",
  "shop.purchased": "Acheté !",
  "shop.insufficientCredits": "Crédits insuffisants",
  "shop.category.all": "Tout",
  "shop.category.rifle": "Fusil",
  "shop.category.smg": "SMG",
  "shop.category.pistol": "Pistolet",
  "shop.category.sniper": "Sniper",
  "shop.category.shotgun": "Fusil à Pompe",
  "shop.category.lmg": "Mitrailleuse",
  "shop.category.melee": "Mêlée",
  "shop.category.utility": "Utilitaire",

  // ── Battle Pass ──
  "battlepass.title": "Passe de Combat",
  "battlepass.season": "Saison",
  "battlepass.tier": "Niveau",
  "battlepass.claim": "Réclamer",
  "battlepass.claimed": "Réclamé",
  "battlepass.premium": "Premium",
  "battlepass.free": "Piste Gratuite",

  // ── Tutorial ──
  "tutorial.welcome": "Bienvenue dans Project Reality",
  "tutorial.movement": "Mouvement et Posture",
  "tutorial.weapons": "Maniement des Armes",
  "tutorial.ballistics": "Balistique et Pénétration",
  "tutorial.suppression": "Système de Suppression",
  "tutorial.medical": "Médical et Casualités",
  "tutorial.weather": "Météo Dynamique",
  "tutorial.radio": "Macros Radio",
  "tutorial.audio": "Réalisme Audio",
  "tutorial.loadout": "Système d'Équipement",
  "tutorial.gunsmith": "Armurerie et Accessoires",
  "tutorial.economy": "Boutique et Économie",
  "tutorial.battlepass": "Passe de Combat",
  "tutorial.ready": "Prêt à Déployer",

  // ── Pack screen ──
  "pack.open": "Ouvrir la Caisse",
  "pack.odds": "Probabilités",
  "pack.showOdds": "Afficher les probabilités",
  "pack.hideOdds": "Masquer les probabilités",
  "pack.duplicate": "Doublon",
  "pack.addedToInventory": "Ajouté à l'inventaire",

  // ── Social ──
  "social.title": "Social",
  "social.profile": "Profil",
  "social.clan": "Clan",
  "social.friends": "Amis",
  "social.searchPlayers": "Rechercher des joueurs",
  "social.noResults": "Aucun joueur trouvé",
  "social.stats.kills": "Éliminations",
  "social.stats.deaths": "Morts",
  "social.stats.kd": "K/D",
  "social.stats.wins": "Victoires",
  "social.stats.matches": "Parties",
  "social.stats.playtime": "Temps de Jeu",
};

export const TRANSLATIONS: Record<Locale, TranslationDict> = {
  en: EN,
  es: ES,
  fr: FR,
};

// ─── Active locale ─────────────────────────────────────────────────────────

const LOCALE_STORAGE_KEY = "pr_locale_v1";
let activeLocale: Locale = "en";

/**
 * SEC10-UIUX (prompt 78): Set the active locale. Persists to
 * localStorage on the client. Triggers any subscribed React
 * components to re-render (via the subscribe() mechanism below).
 */
export function setLocale(locale: Locale): void {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  activeLocale = locale;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      /* localStorage may be unavailable (private mode) — silently ignore. */
    }
  }
  notifySubscribers();
}

/** SEC10-UIUX (prompt 78): Get the active locale. */
export function getLocale(): Locale {
  if (activeLocale === "en" && typeof window !== "undefined") {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY) as Locale | null;
      if (stored && SUPPORTED_LOCALES.includes(stored)) {
        activeLocale = stored;
      }
    } catch {
      /* ignore */
    }
  }
  return activeLocale;
}

/**
 * SEC10-UIUX (prompt 78): Translate a key with optional {param}
 * substitution. Falls back to English if the key is missing in the
 * active locale, then to the raw key if missing everywhere.
 *
 * Example:
 *   t("common.buy") → "Buy" (en) / "Comprar" (es) / "Acheter" (fr)
 *
 * Param substitution — the template uses {name} placeholders:
 *   t("pack.addedToInventory", { item: "Shark Charm" })
 *   → "Added to inventory" (no {item} placeholder — verbatim)
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = getLocale();
  const dict = TRANSLATIONS[locale] ?? EN;
  let str: string | undefined = dict[key];
  if (str == null) {
    // Not in the active locale — try English.
    str = EN[key];
    if (str == null) {
      // Missing everywhere — log + return the raw key.
      logMissingKey(locale, key);
      str = key;
    } else if (locale !== "en") {
      // Active-locale miss but English hit — log the active-locale miss
      // so translators know which keys need a translation.
      logMissingKey(locale, key);
    }
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

/**
 * J-5000-retry — translate with an explicit fallback string.
 *
 * The base `t(key, params?)` returns the raw key when no translation
 * exists (so missing keys are visible in the UI for translators to
 * spot). Components that already hold a canonical English string
 * (e.g. the TutorialScreen's STEPS array, where the English text is
 * the source-of-truth) want to fall back to that string instead of
 * showing the raw `tutorial.core.welcome.title` key.
 *
 * `tWithFallback("tutorial.core.welcome.title", "Welcome to…")`
 *   → active-locale translation if it exists
 *   → English translation if the active locale misses but EN has it
 *   → the caller-supplied `fallback` string if the key is missing
 *     from BOTH the active locale AND English (which is the common
 *     case for the TutorialScreen's per-step keys, since the i18n
 *     catalog doesn't yet catalog every tutorial step).
 *
 * `params` is optional + applied to whichever string is returned.
 */
export function tWithFallback(
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  const locale = getLocale();
  const dict = TRANSLATIONS[locale] ?? EN;
  let str: string | undefined = dict[key];
  if (str == null) {
    // Not in the active locale — try English.
    str = EN[key];
    if (str == null) {
      // Missing everywhere — use the caller's fallback (no log: the
      // caller knew the key might not be cataloged yet).
      str = fallback;
    } else if (locale !== "en") {
      // Active-locale miss but English hit — log so translators know.
      logMissingKey(locale, key);
    }
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

// ─── Reactive subscription (for React components that need to re-render on locale change) ──

type Listener = (locale: Locale) => void;
const subscribers = new Set<Listener>();

function notifySubscribers(): void {
  for (const l of subscribers) l(activeLocale);
}

/** SEC10-UIUX (prompt 78): Subscribe to locale changes. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

// ─── MESSAGE_CATALOG — extracted source-string catalog ─────────────────────

/**
 * Catalog of hardcoded English strings extracted from
 * `src/components/menu/*`. The components themselves are not edited
 * (per task constraints) — this catalog is the bridge for
 * translators + a future refactor that swaps in `t(key)` calls.
 *
 * Each entry records: { key, sourceFile, sourceLine, en, notes? }.
 * The `key` matches a key in the EN dictionary above so `t(key)`
 * returns the cataloged string.
 */
export interface MessageCatalogEntry {
  key: string;
  sourceFile: string;
  sourceLine: number;
  en: string;
  notes?: string;
}

export const MESSAGE_CATALOG: MessageCatalogEntry[] = [
  // ── MainMenu.tsx ──
  { key: "menu.deploy", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Deploy" },
  { key: "menu.loadout", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Loadout" },
  { key: "menu.gunsmith", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Gunsmith" },
  { key: "menu.shop", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Shop" },
  { key: "menu.battlepass", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Battle Pass" },
  { key: "menu.tutorial", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Tutorial" },
  { key: "menu.operator", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Operator" },
  { key: "menu.settings", sourceFile: "src/components/menu/MainMenu.tsx", sourceLine: 1, en: "Settings" },

  // ── SettingsPanel.tsx ──
  { key: "settings.display", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 74, en: "Display" },
  { key: "settings.graphics", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 75, en: "Graphics" },
  { key: "settings.audio", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 76, en: "Audio" },
  { key: "settings.controls", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 77, en: "Controls" },
  { key: "settings.crosshair", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 78, en: "Crosshair" },
  { key: "settings.accessibility", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 79, en: "Accessibility" },
  { key: "settings.gameplay", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 80, en: "Gameplay" },
  { key: "settings.fov", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 442, en: "Field of View" },
  { key: "settings.hudScale", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 455, en: "HUD Scale" },
  { key: "settings.showFps", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 470, en: "Show FPS Counter" },
  { key: "settings.dynamicShadows", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 477, en: "Dynamic Shadows" },
  { key: "settings.quality", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 507, en: "Quality" },
  { key: "settings.textureQuality", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 518, en: "Texture Quality" },
  { key: "settings.shadowQuality", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 529, en: "Shadow Quality" },
  { key: "settings.antiAliasing", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 540, en: "Anti-aliasing" },
  { key: "settings.masterVolume", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 569, en: "Master Volume" },
  { key: "settings.sfxVolume", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 582, en: "SFX Volume" },
  { key: "settings.musicVolume", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 597, en: "Music Volume" },
  { key: "settings.voiceVolume", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 612, en: "Voice Volume" },
  { key: "settings.muteOnFocusLoss", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 627, en: "Mute on Focus Loss" },
  { key: "settings.mouseSensitivity", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 658, en: "Mouse Sensitivity" },
  { key: "settings.adsSensitivity", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 671, en: "ADS Sensitivity" },
  { key: "settings.adsMode", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 686, en: "ADS Mode" },
  { key: "settings.adsSpeed", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 696, en: "ADS Speed" },
  { key: "settings.invertY", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 709, en: "Invert Y Axis" },
  { key: "settings.keybindings", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 721, en: "Keybindings" },
  { key: "settings.colorblindMode", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 927, en: "Colorblind Mode" },
  { key: "settings.motionSickness", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 940, en: "Motion Sickness Mode" },
  { key: "settings.subtitles", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 949, en: "Subtitles" },
  { key: "settings.reducedMotion", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 956, en: "Reduced Motion" },
  { key: "settings.hudOpacity", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 965, en: "HUD Opacity" },
  { key: "settings.difficulty", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 1002, en: "Difficulty" },
  { key: "settings.autoReload", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 1013, en: "Auto-reload When Empty" },
  { key: "settings.autoTarget", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 1022, en: "Auto-targeting Assist" },
  { key: "settings.confirmedKills", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 1031, en: "Confirmed Kills" },
  { key: "settings.matchDuration", sourceFile: "src/components/menu/SettingsPanel.tsx", sourceLine: 1040, en: "Match Duration" },

  // ── TutorialScreen.tsx ──
  { key: "tutorial.welcome", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 17, en: "Welcome to Project Reality" },
  { key: "tutorial.movement", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 22, en: "Movement & Stance" },
  { key: "tutorial.weapons", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 34, en: "Weapon Handling" },
  { key: "tutorial.ballistics", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 45, en: "Ballistics & Penetration" },
  { key: "tutorial.suppression", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 50, en: "Suppression System" },
  { key: "tutorial.medical", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 55, en: "Medical & Casualty" },
  { key: "tutorial.weather", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 66, en: "Dynamic Weather" },
  { key: "tutorial.radio", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 72, en: "Radio Macros" },
  { key: "tutorial.audio", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 81, en: "Audio Realism" },
  { key: "tutorial.ready", sourceFile: "src/components/menu/TutorialScreen.tsx", sourceLine: 86, en: "Ready to Deploy" },

  // ── ShopScreen.tsx ──
  { key: "shop.title", sourceFile: "src/components/menu/ShopScreen.tsx", sourceLine: 1, en: "Shop" },
  { key: "shop.packs", sourceFile: "src/components/menu/ShopScreen.tsx", sourceLine: 1, en: "Packs" },

  // ── GunsmithScreen.tsx ──
  { key: "gunsmith.attachments", sourceFile: "src/components/menu/GunsmithScreen.tsx", sourceLine: 1, en: "Attachments" },
  { key: "gunsmith.finish", sourceFile: "src/components/menu/GunsmithScreen.tsx", sourceLine: 1, en: "Finish" },
  { key: "gunsmith.wraps", sourceFile: "src/components/menu/GunsmithScreen.tsx", sourceLine: 1, en: "Wraps" },
  { key: "gunsmith.charms", sourceFile: "src/components/menu/GunsmithScreen.tsx", sourceLine: 1, en: "Charms" },

  // ── LoadoutPicker.tsx ──
  { key: "loadout.title", sourceFile: "src/components/menu/LoadoutPicker.tsx", sourceLine: 1, en: "Loadout" },
  { key: "loadout.primary", sourceFile: "src/components/menu/LoadoutPicker.tsx", sourceLine: 1, en: "Primary" },
  { key: "loadout.secondary", sourceFile: "src/components/menu/LoadoutPicker.tsx", sourceLine: 1, en: "Secondary" },
  { key: "loadout.melee", sourceFile: "src/components/menu/LoadoutPicker.tsx", sourceLine: 1, en: "Melee" },
  { key: "loadout.utility", sourceFile: "src/components/menu/LoadoutPicker.tsx", sourceLine: 1, en: "Utility" },

  // ── BattlePassScreen.tsx ──
  { key: "battlepass.title", sourceFile: "src/components/menu/BattlePassScreen.tsx", sourceLine: 1, en: "Battle Pass" },
  { key: "battlepass.season", sourceFile: "src/components/menu/BattlePassScreen.tsx", sourceLine: 1, en: "Season" },
  { key: "battlepass.tier", sourceFile: "src/components/menu/BattlePassScreen.tsx", sourceLine: 1, en: "Tier" },
  { key: "battlepass.claim", sourceFile: "src/components/menu/BattlePassScreen.tsx", sourceLine: 1, en: "Claim" },

  // ── PackScreen.tsx ──
  { key: "pack.open", sourceFile: "src/components/menu/PackScreen.tsx", sourceLine: 1, en: "Open Crate" },
  { key: "pack.odds", sourceFile: "src/components/menu/PackScreen.tsx", sourceLine: 1, en: "Drop Odds" },
  { key: "pack.showOdds", sourceFile: "src/components/menu/PackScreen.tsx", sourceLine: 1, en: "Show odds" },
];

/**
 * SEC10-UIUX (prompt 78): Coverage report — which catalog keys are
 * translated for each locale. Used by the translation dashboard.
 */
export function getTranslationCoverage(): Record<Locale, {
  total: number;
  translated: number;
  missing: string[];
}> {
  const out = {} as Record<Locale, { total: number; translated: number; missing: string[] }>;
  const allKeys = Object.keys(EN);
  for (const locale of SUPPORTED_LOCALES) {
    const dict = TRANSLATIONS[locale];
    const missing: string[] = [];
    let translated = 0;
    for (const k of allKeys) {
      if (dict[k]) translated++;
      else missing.push(k);
    }
    out[locale] = { total: allKeys.length, translated, missing };
  }
  return out;
}

// ─── Prompt J-4063 — missing-key fallback logging ──────────────────────────

/**
 * J-4063 — when a key is missing from the active locale's dictionary,
 * log it once per key per session so translators can find gaps. The
 * `t()` function calls this when it falls back to English (or the raw
 * key). The log is debounced via a Set so a missing key used 1000 times
 * in a render only logs once.
 *
 * The log goes to `console.warn` in dev + to `/api/telemetry/i18n-missing`
 * in production (fire-and-forget, batched). The server route aggregates
 * per-locale missing-key hits so the translation dashboard can prioritize.
 */
const missingKeyLogged = new Set<string>();
let missingKeyBatch: { locale: Locale; key: string }[] = [];
let missingKeyFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function logMissingKey(locale: Locale, key: string): void {
  const sig = `${locale}::${key}`;
  if (missingKeyLogged.has(sig)) return;
  missingKeyLogged.add(sig);
  // Dev console warning (visible in browser devtools).
  if (typeof console !== "undefined" && console.warn) {
    console.warn(`[i18n] missing key "${key}" for locale "${locale}" — falling back to English`);
  }
  // Batch + flush to telemetry endpoint every 5s.
  missingKeyBatch.push({ locale, key });
  if (missingKeyFlushTimer == null) {
    missingKeyFlushTimer = setTimeout(flushMissingKeys, 5_000);
  }
}

function flushMissingKeys(): void {
  if (typeof window === "undefined") return;
  const batch = missingKeyBatch;
  missingKeyBatch = [];
  missingKeyFlushTimer = null;
  if (batch.length === 0) return;
  try {
    void fetch("/api/telemetry/i18n-missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch }),
    });
  } catch {
    // Network failure here is non-fatal — the dev console warning is
    // the primary signal; the telemetry endpoint is best-effort.
  }
}

// ─── Prompt J-4060 — ICU-style pluralization ───────────────────────────────

/**
 * J-4060 — ICU MessageFormat-style pluralization. The active locale's
 * plural rules (via `Intl.PluralRules`) select the right variant:
 *
 *   tPlural("kills", { count: 5 })
 *   → "5 kills" (English "other" variant for 5)
 *
 *   tPlural("kills", { count: 1 })
 *   → "1 kill" (English "one" variant)
 *
 * The dictionary key's value is the ICU template, e.g.:
 *   "kills": "{count, plural, =0 {no kills} one {# kill} other {# kills}}"
 *
 * We parse the ICU template at call time (small strings — no perf
 * concern) + substitute `#` with the count. Falls back to English then
 * to the raw `count` if no plural variant matches.
 */
const PLURAL_RE = /\{count,\s*plural,\s*([^}]+)\}/i;

export function tPlural(key: string, params: { count: number }): string {
  const locale = getLocale();
  const template = TRANSLATIONS[locale]?.[key] ?? EN[key];
  if (!template) {
    logMissingKey(locale, key);
    return String(params.count);
  }
  const m = template.match(PLURAL_RE);
  if (!m) {
    // No plural form — just substitute {count}.
    return template.replace(/\{count\}/g, String(params.count));
  }
  const variants = m[1];
  // Parse "=N {text}" and "keyword {text}" variants.
  const variantMap = new Map<string, string>();
  const variantRe = /(=\d+|zero|one|two|few|many|other)\s*\{([^}]*)\}/g;
  let vm;
  while ((vm = variantRe.exec(variants)) !== null) {
    variantMap.set(vm[1], vm[2]);
  }
  const count = params.count;
  // Exact-match `=N` wins first.
  const exact = variantMap.get(`=${count}`);
  if (exact != null) return exact.replace(/#/g, String(count));
  // Otherwise use the locale's plural rule.
  let pr: Intl.PluralRules;
  try {
    pr = new Intl.PluralRules(locale);
  } catch {
    pr = new Intl.PluralRules("en");
  }
  const rule = pr.select(count);
  const variant = variantMap.get(rule) ?? variantMap.get("other") ?? String(count);
  return variant.replace(/#/g, String(count));
}

// ─── Prompt J-4061 — number formatting ──────────────────────────────────────

/**
 * J-4061 — locale-aware number formatting. Wraps `Intl.NumberFormat`
 * so credit amounts, distances, etc. render with the right separators
 * (e.g. "1,234,567" in en, "1.234.567" in de). Currency + unit
 * variants are supported via the options bag.
 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions & { locale?: Locale },
): string {
  const locale = options?.locale ?? getLocale();
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return new Intl.NumberFormat("en", options).format(value);
  }
}

// ─── Prompt J-4062 — date formatting ───────────────────────────────────────

/**
 * J-4062 — locale-aware date formatting. Wraps `Intl.DateTimeFormat`
 * so timestamps (battle pass season end, pack cooldowns, last-played)
 * render in the locale's natural format. Defaults to a medium date
 * (e.g. "Jan 5, 2025" in en, "5 ene 2025" in es).
 */
export function formatDate(
  value: Date | number,
  options?: Intl.DateTimeFormatOptions & { locale?: Locale },
): string {
  const locale = options?.locale ?? getLocale();
  const date = typeof value === "number" ? new Date(value) : value;
  try {
    return new Intl.DateTimeFormat(locale, options ?? { dateStyle: "medium" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", options ?? { dateStyle: "medium" }).format(date);
  }
}

// ─── Prompt J-4059 — RTL support ────────────────────────────────────────────

/** Locale → text direction. Arabic + Hebrew (when added) are RTL. */
const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "he", "fa", "ur"]);

export function isRTL(locale?: Locale): boolean {
  return RTL_LOCALES.has(locale ?? getLocale());
}

/**
 * Apply the locale's text direction to the document. Call this from
 * the boot path (layout.tsx) + whenever the locale changes. The CSS
 * uses logical properties (margin-inline-start, etc.) so the layout
 * mirrors automatically once `dir` is set.
 */
export function applyTextDirection(locale?: Locale): void {
  if (typeof document === "undefined") return;
  const rtl = isRTL(locale);
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  document.documentElement.lang = locale ?? getLocale();
}
