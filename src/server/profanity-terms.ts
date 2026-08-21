/**
 * English terms and phrases for the Insights counter.
 *
 * Generated from LDNOOBW's "List of Dirty, Naughty, Obscene, and Otherwise
 * Bad Words" (English list), retrieved 2026-08-21. Source is CC BY 4.0:
 * https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
 *
 * Keep this data separate from the matcher so updates are reviewable and do
 * not require editing matching logic. It intentionally includes slurs and
 * sexual terms because the counter is requested to be comprehensive; Insights
 * always censors a matched label before displaying it.
 */
export const PROFANITY_TERMS = [
  // Common conversational variants retained from the original Insights counter.
  'damn', 'damned', 'damning', 'dammit', 'damnit', 'goddamn', 'goddammit', 'goddamnit', 'hell',
  'fucked', 'fucker', 'fuckers', 'fuckface', 'fuckhead', 'fuckin', 'fucking', 'fuckings', 'fucknut', 'fucks', 'fucktard', 'fucktards', 'fuckup', 'fuckups',
  'shitted', 'shitting', 'shithead', 'shitheads', 'shitshow', 'shitshows', 'shits', 'shittier', 'shittiest',
  // Common modern terms, inflections, compounds, and abbreviations absent
  // from the upstream list. These are kept explicit so the counter remains
  // reviewable rather than relying on a broad, false-positive-prone stem rule.
  'arse', 'arses', 'arsewipe', 'arsewipes', 'assclown', 'assclowns', 'asshat', 'asshats', 'asses', 'assface', 'assfaces', 'assfuck', 'assfucker', 'assholes', 'asswipe', 'asswipes',
  'bastards', 'bitchass', 'bitchasses', 'bitching', 'bitchy', 'bollocking', 'bollockings', 'bullshitting', 'bullshits',
  'cockhead', 'cockheads', 'cockshit', 'cocksucker', 'cocksuckers', 'cocksucking', 'cuntface', 'cuntfaces', 'cunthead', 'cuntheads', 'cunts',
  'dickhead', 'dickheads', 'dickish', 'dickwad', 'dickwads', 'dipshit', 'dipshits', 'douche', 'douchebag', 'douchebags', 'douchey',
  'dumbass', 'dumbasses', 'dumbfuck', 'dumbfucks', 'fml', 'ffs', 'frigger', 'frigging', 'friggin', 'fricking', 'frickin', 'frick', 'fricks',
  'jackass', 'jackasses', 'motherfuckers', 'motherfucking', 'pissed', 'pisses', 'pisshead', 'pissheads', 'pissing', 'piss off', 'piss-off', 'pissy',
  'prick', 'pricks', 'prickhead', 'prickheads', 'scumbag', 'scumbags', 'shitbag', 'shitbags', 'shitfaced', 'shit-for-brains', 'shitfuck', 'shitfucks', 'shitstain', 'shitstains',
  'twats', 'wanker', 'wankers', 'wanking', 'wankstain', 'wankstains', 'whorebag', 'whorebags', 'wtf',
  '2g1c', '2 girls 1 cup', 'acrotomophilia', 'alabama hot pocket', 'alaskan pipeline', 'anal', 'anilingus', 'anus', 'apeshit', 'arsehole', 'ass', 'asshole', 'assmunch', 'auto erotic', 'autoerotic', 'babeland', 'baby batter', 'baby juice', 'ball gag', 'ball gravy', 'ball kicking', 'ball licking', 'ball sack', 'ball sucking', 'bangbros', 'bangbus', 'bareback', 'barely legal', 'barenaked', 'bastard', 'bastardo', 'bastinado', 'bbw', 'bdsm', 'beaner', 'beaners', 'beaver cleaver', 'beaver lips', 'beastiality', 'bestiality', 'big black', 'big breasts', 'big knockers', 'big tits', 'bimbos', 'birdlock', 'bitch', 'bitches', 'black cock', 'blonde action', 'blonde on blonde action', 'blowjob', 'blow job', 'blow your load', 'blue waffle', 'blumpkin', 'bollocks', 'bondage', 'boner', 'boob', 'boobs', 'booty call', 'brown showers', 'brunette action', 'bukkake', 'bulldyke', 'bullet vibe', 'bullshit', 'bung hole', 'bunghole', 'busty', 'butt', 'buttcheeks', 'butthole', 'camel toe', 'camgirl', 'camslut', 'camwhore', 'carpet muncher', 'carpetmuncher', 'chocolate rosebuds', 'cialis', 'circlejerk', 'cleveland steamer', 'clit', 'clitoris', 'clover clamps', 'clusterfuck', 'cock', 'cocks', 'coprolagnia', 'coprophilia', 'cornhole', 'coon', 'coons', 'creampie', 'cum', 'cumming', 'cumshot', 'cumshots', 'cunnilingus', 'cunt', 'darkie', 'date rape', 'daterape', 'deep throat', 'deepthroat', 'dendrophilia', 'dick', 'dildo', 'dingleberry', 'dingleberries', 'dirty pillows', 'dirty sanchez', 'doggie style', 'doggiestyle', 'doggy style', 'doggystyle', 'dog style', 'dolcett', 'domination', 'dominatrix', 'dommes', 'donkey punch', 'double dong', 'double penetration', 'dp action', 'dry hump', 'dvda', 'eat my ass', 'ecchi', 'ejaculation', 'erotic', 'erotism', 'escort', 'eunuch', 'fag', 'faggot', 'fecal', 'felch', 'fellatio', 'feltch', 'female squirting', 'femdom', 'figging', 'fingerbang', 'fingering', 'fisting', 'foot fetish', 'footjob', 'frotting', 'fuck', 'fuck buttons', 'fuckin', 'fucking', 'fucktards', 'fudge packer', 'fudgepacker', 'futanari', 'gangbang', 'gang bang', 'gay sex', 'genitals', 'giant cock', 'girl on', 'girl on top', 'girls gone wild', 'goatcx', 'goatse', 'god damn', 'gokkun', 'golden shower', 'goodpoop', 'goo girl', 'goregasm', 'grope', 'group sex', 'g-spot', 'guro', 'hand job', 'handjob', 'hard core', 'hardcore', 'hentai', 'homoerotic', 'honkey', 'hooker', 'horny', 'hot carl', 'hot chick', 'how to kill', 'how to murder', 'huge fat', 'humping', 'incest', 'intercourse', 'jack off', 'jail bait', 'jailbait', 'jelly donut', 'jerk off', 'jigaboo', 'jiggaboo', 'jiggerboo', 'jizz', 'juggs', 'kike', 'kinbaku', 'kinkster', 'kinky', 'knobbing', 'leather restraint', 'leather straight jacket', 'lemon party', 'livesex', 'lolita', 'lovemaking', 'make me come', 'male squirting', 'masturbate', 'masturbating', 'masturbation', 'menage a trois', 'milf', 'missionary position', 'mong', 'motherfucker', 'mound of venus', 'mr hands', 'muff diver', 'muffdiving', 'nambla', 'nawashi', 'negro', 'neonazi', 'nigga', 'nigger', 'nig nog', 'nimphomania', 'nipple', 'nipples', 'nsfw', 'nsfw images', 'nude', 'nudity', 'nutten', 'nympho', 'nymphomania', 'octopussy', 'omorashi', 'one cup two girls', 'one guy one jar', 'orgasm', 'orgy', 'paedophile', 'paki', 'panties', 'panty', 'pedobear', 'pedophile', 'pegging', 'penis', 'phone sex', 'piece of shit', 'pikey', 'pissing', 'piss pig', 'pisspig', 'playboy', 'pleasure chest', 'pole smoker', 'ponyplay', 'poof', 'poon', 'poontang', 'punany', 'poop chute', 'poopchute', 'porn', 'porno', 'pornography', 'prince albert piercing', 'pthc', 'pubes', 'pussy', 'queaf', 'queef', 'quim', 'raghead', 'raging boner', 'rape', 'raping', 'rapist', 'rectum', 'reverse cowgirl', 'rimjob', 'rimming', 'rosy palm', 'rosy palm and her 5 sisters', 'rusty trombone', 'sadism', 'santorum', 'scat', 'schlong', 'scissoring', 'semen', 'sex', 'sexcam', 'sexo', 'sexy', 'sexual', 'sexually', 'sexuality', 'shaved beaver', 'shaved pussy', 'shemale', 'shibari', 'shit', 'shitblimp', 'shitty', 'shota', 'shrimping', 'skeet', 'slanteye', 'slut', 's&m', 'smut', 'snatch', 'snowballing', 'sodomize', 'sodomy', 'spastic', 'spic', 'splooge', 'splooge moose', 'spooge', 'spread legs', 'spunk', 'strap on', 'strapon', 'strappado', 'strip club', 'style doggy', 'suck', 'sucks', 'suicide girls', 'sultry women', 'swastika', 'swinger', 'tainted love', 'taste my', 'tea bagging', 'threesome', 'throating', 'thumbzilla', 'tied up', 'tight white', 'tit', 'tits', 'titties', 'titty', 'tongue in a', 'topless', 'tosser', 'towelhead', 'tranny', 'tribadism', 'tub girl', 'tubgirl', 'tushy', 'twat', 'twink', 'twinkie', 'two girls one cup', 'undressing', 'upskirt', 'urethra play', 'urophilia', 'vagina', 'venus mound', 'viagra', 'vibrator', 'violet wand', 'vorarephilia', 'voyeur', 'voyeurweb', 'voyuer', 'vulva', 'wank', 'wetback', 'wet dream', 'white power', 'whore', 'worldsex', 'wrapping men', 'wrinkled starfish', 'xx', 'xxx', 'yaoi', 'yellow showers', 'yiffy', 'zoophilia', '🖕',
] as const;

/** Deliberately masked spellings people use in normal chat. */
export const MASKED_PROFANITY_PATTERNS = [
  { pattern: 'f(?:[\\\\*]){2,}', term: 'fuck' },
  { pattern: 'f[*!#$%]ck', term: 'fuck' },
  { pattern: 'sh[*!#$%]t', term: 'shit' },
  { pattern: 'b[*!#$%]tch', term: 'bitch' },
  { pattern: 'c[*!#$%]nt', term: 'cunt' },
  { pattern: 'd[*!#$%]ck', term: 'dick' },
] as const;
