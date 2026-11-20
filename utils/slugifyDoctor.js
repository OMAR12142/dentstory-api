/**
 * slugifyDoctor.js
 * Deterministic Arabic & English Doctor Name to URL Slug converter.
 * Converts names like "د. كريم محمود" -> "dr-karim-mahmoud" and "Dr. Sara Ahmed" -> "dr-sara-ahmed".
 */

const COMMON_ARABIC_NAMES = {
  // Common first & family names
  'محمد': 'mohamed',
  'محمود': 'mahmoud',
  'احمد': 'ahmed',
  'أحمد': 'ahmed',
  'إحمد': 'ahmed',
  'علي': 'ali',
  'على': 'ali',
  'عمر': 'omar',
  'عمرو': 'amr',
  'كريم': 'karim',
  'فريد': 'farid',
  'سارة': 'sara',
  'ساره': 'sara',
  'سليم': 'salim',
  'سليمان': 'soliman',
  'يوسف': 'youssef',
  'ابراهيم': 'ibrahim',
  'إبراهيم': 'ibrahim',
  'حسن': 'hassan',
  'حسين': 'hussein',
  'مصطفى': 'mostafa',
  'مصطفي': 'mostafa',
  'طارق': 'tarek',
  'خالد': 'khaled',
  'وليد': 'waleed',
  'شريف': 'sherif',
  'حسام': 'hossam',
  'هشام': 'hesham',
  'عصام': 'essam',
  'ماجد': 'maged',
  'ماجدة': 'magda',
  'رامي': 'ramy',
  'سامي': 'samy',
  'هاني': 'hany',
  'ياسر': 'yasser',
  'تامر': 'tamer',
  'عادل': 'adel',
  'أيمن': 'ayman',
  'ايمن': 'ayman',
  'أشرف': 'ashraf',
  'اشرف': 'ashraf',
  'أمين': 'amin',
  'امين': 'amin',
  'أميرة': 'amira',
  'اميرة': 'amira',
  'مريم': 'mariam',
  'فاطمة': 'fatma',
  'نور': 'nour',
  'منى': 'mona',
  'هدى': 'hoda',
  'هدير': 'hadeer',
  'نادية': 'nadia',
  'رانيا': 'rania',
  'دينا': 'dina',
  'شروق': 'shorouk',
  'سلمى': 'salma',
  'آية': 'aya',
  'اية': 'aya',
  'إيمان': 'eman',
  'ايمان': 'eman',
  'ياسمين': 'yasmin',
  'داليا': 'dalia',
  'رنا': 'rana',
  'ملك': 'malak',
  'فريدة': 'farida',
  'جنة': 'janna',
  'روان': 'rawan',
  'نهى': 'noha',
  'مي': 'mai',
  'ندى': 'nada',
  'بسنت': 'passant',
  'مروة': 'marwa',
  'اسماء': 'asmaa',
  'أسماء': 'asmaa',
  'رضوى': 'radwa',
  'رحاب': 'rehab',
  'نجلاء': 'naglaa',
  'دعاء': 'doaa',
  'شيماء': 'shaimaa',
  'هبة': 'heba',
  'ريهام': 'reham',
  'منار': 'manar',
  'إسراء': 'esraa',
  'اسراء': 'esraa',
  'هند': 'hend',
  'أماني': 'amany',
  'اماني': 'amany',
  'سلوى': 'salwa',
  'زينب': 'zeinab',
  'خديجة': 'khadija',
  'عائشة': 'aisha',
  'حبيبة': 'habiba',
  'شمس': 'shams',
  'رويدا': 'rowaida',
  'مروان': 'marwan',
  'زياد': 'ziad',
  'يحيى': 'yahia',
  'حمزة': 'hamza',
  'بلال': 'belal',
  'معاذ': 'moaz',
  'أنس': 'anas',
  'انس': 'anas',
  'سيف': 'seif',
  'آدم': 'adam',
  'ادم': 'adam',
  'باسل': 'bassel',
  'شادي': 'shady',
  'مهند': 'mohanad',
  'وسام': 'wessam',
  'نادر': 'nader',
  'حاتم': 'hatem',
  'باسم': 'bassem',
  'سامر': 'samer',
  'بهاء': 'bahaa',
  'ضياء': 'diaa',
  'علاء': 'alaa',
  'وجيه': 'wagih',
  'سامح': 'sameh',
  'مدحت': 'medhat',
  'رفعت': 'refaat',
  'عطية': 'attia',
  'سلامة': 'salama',
  'الشناوي': 'el-shenawy',
  'البدري': 'el-badry',
  'المصري': 'el-masry',
  'الشامي': 'el-shamy',
  'الصاوي': 'el-sawy',
  'الجزار': 'el-gazzar',
  'الحداد': 'el-haddad',
  'النجار': 'el-naggar',
  'القاضي': 'el-kady',
  'الخولى': 'el-kholy',
  'الخولي': 'el-kholy',
  'عثمان': 'othman',
  'رمضان': 'ramadan',
  'شعبان': 'shaaban',
  'شوقي': 'shawky',
  'صبحي': 'sobhy',
  'فتحي': 'fathy',
  'فوزي': 'fawzy',
  'لطفي': 'lotfy',
  'حمدي': 'hamdy',
  'مجدي': 'magdy',
  'وجدي': 'wagdy',
  'رشدي': 'roshdy',
  'فهمي': 'fahmy',
  'حلمي': 'helmy',
  'بدوي': 'badawy',
  'صبري': 'sabry',
  'يسري': 'yosry',
  'فكري': 'fekry',
  'شكري': 'shokry',
  'نصار': 'nassar',
};

const ARABIC_CHAR_MAP = {
  'ء': '', 'آ': 'aa', 'أ': 'a', 'ؤ': 'o', 'إ': 'e', 'ئ': 'e', 'ا': 'a',
  'ب': 'b', 'ة': 'a', 'ت': 't', 'ث': 'th', 'ج': 'g', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'th', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's',
  'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'k',
  'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w', 'ى': 'a',
  'ي': 'y', 'پ': 'p', 'چ': 'ch', 'ڤ': 'v', 'گ': 'g'
};

/**
 * Strips Arabic diacritics (tashkeel).
 */
function stripArabicDiacritics(str) {
  return str.replace(/[\u064B-\u065F\u0670]/g, '');
}

/**
 * Transliterates an Arabic word into Latin characters.
 */
function transliterateArabicWord(word) {
  const clean = stripArabicDiacritics(word).trim();
  if (!clean) return '';

  // Check known name dictionary first
  if (COMMON_ARABIC_NAMES[clean]) {
    return COMMON_ARABIC_NAMES[clean];
  }

  // Check normalized form (e.g. normalize alefs)
  const normalizedAlef = clean.replace(/[إأآ]/g, 'ا');
  if (COMMON_ARABIC_NAMES[normalizedAlef]) {
    return COMMON_ARABIC_NAMES[normalizedAlef];
  }

  // Character-by-character fallback
  let result = '';
  for (const ch of clean) {
    if (ARABIC_CHAR_MAP[ch] !== undefined) {
      result += ARABIC_CHAR_MAP[ch];
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Converts a dentist name (Arabic or English) into a clean, URL-safe doctor slug.
 * Example:
 *   "د. كريم محمود" -> "dr-karim-mahmoud"
 *   "د. محمد فريد"  -> "dr-mohamed-farid"
 *   "Dr. Sara Ahmed" -> "dr-sara-ahmed"
 *
 * @param {string} rawName - The dentist's raw input name
 * @param {string} [defaultFallback="dr-dentist"] - Fallback if name is empty
 * @returns {string} URL-safe slug starting with "dr-"
 */
function slugifyDoctorName(rawName, defaultFallback = 'dr-dentist') {
  if (!rawName || typeof rawName !== 'string') {
    return defaultFallback;
  }

  // 1. Strip redundant leading titles (English & Arabic)
  let stripped = rawName.trim();
  stripped = stripped.replace(/^(دكتور[ة]?|د[./\s]+|dr[./\s]+|doctor[./\s]+)+/gi, '').trim();

  if (!stripped) {
    return defaultFallback;
  }

  // 2. Split words and transliterate any Arabic words
  const words = stripped.split(/[\s_-]+/);
  const latinWords = [];

  for (const w of words) {
    const isArabic = /[\u0600-\u06FF]/.test(w);
    if (isArabic) {
      const transliterated = transliterateArabicWord(w);
      if (transliterated) latinWords.push(transliterated);
    } else {
      latinWords.push(w);
    }
  }

  // 3. Assemble and sanitize Latin characters
  const rawJoined = latinWords.join('-');
  const cleaned = rawJoined
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  // 4. Strip redundant leading 'dr-' if already present
  const withoutLeadingDr = cleaned.replace(/^dr-+/, '').replace(/^-+|-+$/g, '');

  if (!withoutLeadingDr) {
    return defaultFallback;
  }

  return `dr-${withoutLeadingDr}`;
}

module.exports = {
  slugifyDoctorName,
  COMMON_ARABIC_NAMES,
};
