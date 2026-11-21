// Kinds of item people ask for by their category ("machroub", "may", "chokola", "dekhen") rather than by name.
//   say  — how people call the kind: Arabic, Arabizi, English, French. Compared word for word (and by sound, the skeleton, for
//          words of three sounds or more), so "mashroub" / "machroubet" / "مشروبات" reach "machroub" without listing every spelling.
//   tags — words that mark an item of that kind in its name, its aliases or its section ("SYRO JUS/SOFTDR", "WATER", "Pepsi"),
//          matched at the start of a word ("deterg" → "detergent"); a tag of four letters or fewer only as a whole word
//          ("bon" is the section "CHOBISC/GUM/BON", not "bonduelle"; "tea" is not "team"). "=word" is a whole word whatever
//          its length ("=water", not "watermelon"); "-word" keeps an item OUT of the kind ("-tuna": tuna in water is not water).
//   notIn — categories (the shared list's keys = products.section) whose items are never of this kind, whatever their name says:
//          cheese-flavoured chips are not cheese, chocolate milk is not what "7alib" asks for (97).
//   food  — false for the kinds that are not food or drink. Every other kind also leaves out NON_FOOD: a deodorant "coffee",
//          an irrigation "water" pipe and the section "Pain Relief" (French "pain" = bread) are not food.
// The same list is seeded into suqa.match_concepts (supabase/schema/84_category_matching.sql; not_in in 97) for the assistant's
// search — keep them in step (packages/pos-core/src/item-match.test.ts compares them).
export type Concept = { id: string; say: string[]; tags: string[]; notIn?: string[]; food?: boolean };

/** Categories that hold no food or drink (keys of the shared item categories, 87). A shop's own category is in neither list and is left alone. */
export const NON_FOOD: string[] = [
  'Tobacco', 'Vapes', 'Lighters, Gas & Charcoal', 'Argile', 'Argile Tobacco (Maassel)', 'Argile Charcoal', 'Vitamins', 'Pain Relief', 'Hygiene & Sanitizers', 'Skin Care',
  'Detergents & Disinfectants', 'Tissues, Wipes & Pads', 'Air Fresheners', 'Insect Control', 'Household', 'Disposable Plates & Cups', 'Candles', 'Shampoo & Conditioner', 'Deodorants',
  'Shaving', 'Soap & Hand Wash', 'Toothpaste', 'Toothbrushes', 'Cosmetics & Body Care', 'Hair Colour', 'Batteries', 'Electrical', 'Phones & Accessories',
  'Seeds', 'Fertilizers, Pesticides & Soil', 'Irrigation', 'Machines', 'Tools & Spare Parts', 'Tanks, Containers & Shade Nets', 'Beekeeping', 'Pest Control (Public Health)', 'Oils & Lubricants', 'Olive Harvest & Sacks',
];
/** every category a kind never matches in: its own list, plus NON_FOOD for a kind of food or drink */
export const notInOf = (c: Concept): string[] => [...(c.food === false ? [] : NON_FOOD), ...(c.notIn ?? [])];

export const CONCEPTS: Concept[] = [
  { id: 'drinks',
    say: ['machroub', 'mashroub', 'machroubet', 'mashroubet', 'mashroubat', 'مشروب', 'مشروبات', 'drink', 'drinks', 'beverage', 'beverages', 'boisson', 'boissons', 'soft drink', 'soft drinks', 'soda', 'sodas'],
    tags: ['drink', 'beverage', 'boisson', 'softdr', 'soft drink', 'soda', 'مشروب', 'مشروبات', 'jus', 'juice', 'عصير', '=water', 'مياه', 'cola', 'كولا', 'pepsi', 'بيبسي', '7up', 'سفن', 'miranda', 'mirinda', 'ميرندا', 'sprite', 'سبرايت', 'fanta', 'فانتا', 'energy', 'طاقة', 'red bull', 'ريد بول', 'ice tea', 'nestea', 'gazeuse', 'غازية', 'syro', 'sirop', 'شراب', 'جلاب', 'tamarind', 'تمر هندي', '-vape', '-فيب', '-tuna', '-تونا', '-micellar', '-ميسيلار',
           // alcohol is asked for by its own words (bira, 3ara2, alcohol): "machroub" means soft drinks
           '-alcool', '-alcohol', '-كحول', '-روحية', '-beer', '-bira', '-بيرة', '-arak', '-عرق', '-whisk', '-ويسكي', '-vodka', '-فودكا', '-wine', '-نبيذ', '-liqueur', '-ليكور', '-gin', '-rum'],
    notIn: ['Cakes, Desserts & Baking', 'Chocolate, Biscuits & Candy', 'Ice Cream'] },
  { id: 'water',
    say: ['may', 'mayy', 'maye', 'mayye', 'mayyeh', 'mai', 'miyah', 'miyeh', 'mia', 'مي', 'مية', 'مياه', 'ماء', 'water', 'eau'],
    tags: ['=water', 'مياه', 'sohat', 'صحة', 'tannourine', 'تنورين', 'sannine', 'صنين', 'rim', 'ريم', 'نسمة', 'aquafina', 'nestle pure', '-tuna', '-تونا', '-تونة', '-micellar', '-ميسيلار', '-gum', '-علكة', '-vape', '-فيب', '-wipes', '-محارم'],
    notIn: ['Ice Cream'] },
  { id: 'juice',
    say: ['3asir', '3aseer', 'asir', 'aseer', 'عصير', 'عصاير', 'juice', 'juices', 'jus'],
    tags: ['juice', 'juicy', 'عصير', 'nectar', 'نكتار', 'jus de'] },   // not "jus" alone: "SYRO JUS/SOFTDR" is every soft drink
  { id: 'chocolate',
    say: ['chokola', 'chocola', 'shokola', 'chocolat', 'chocolate', 'chocolates', 'choco', 'شوكولا', 'شوكولاته', 'شوكولاتة', 'شوكولا'],
    tags: ['choco', 'شوكولا', 'cacao', 'kitkat', 'kit kat', 'snickers', 'twix', 'mars', 'galaxy', 'kinder', 'nutella', 'bounty', 'milka', 'toblerone', 'unica', 'يونيكا'],
    notIn: ['Ice Cream'] },
  { id: 'chips',
    say: ['chips', 'tchips', 'shibs', 'chibs', 'شيبس', 'شيبسات', 'crisps', 'رقائق'],
    tags: ['chips', 'شيبس', 'crisps', 'pringles', 'برينغلز', 'doritos', 'lays', 'ليز', 'cheetos', 'تشيتوس', 'master chips'] },
  { id: 'sweets',
    say: ['sakaker', 'skaker', 'سكاكر', 'bonbon', 'bonbons', 'بونبون', 'candy', 'candies', '7elwiyet', 'helwiyet', '7elwayet', 'حلويات', 'sweets', 'bombon'],
    tags: ['bon', 'بونبون', 'candy', 'سكاكر', 'sweet', 'حلو', 'gum', 'علكة', 'chewing', 'lollipop', 'مصاصة', 'marshmallow', 'gelo', 'jelly', 'جيلي'],
    notIn: ['Chips & Nuts', 'Canned Food', 'Grains, Pulses & Spices'] },
  { id: 'coffee',
    say: ['ahwe', 'ahweh', '2ahwe', '2ahweh', 'kahwe', 'qahwa', 'قهوة', 'قهوه', 'coffee', 'cafe', 'nescafe', 'نسكافيه'],
    tags: ['coffee', 'cafe', 'قهوة', 'قهوه', 'nescafe', 'نسكافيه', 'espresso', 'cappuccino', 'كابتشينو', 'najjar', 'نجار'],
    notIn: ['Chocolate, Biscuits & Candy'] },
  { id: 'tea',
    say: ['shay', 'chay', 'chai', 'shai', 'شاي', 'tea', 'zhourat', 'zhurat', 'زهورات'],
    tags: ['tea', 'شاي', 'zhourat', 'زهورات', 'lipton', 'ليبتون', 'infusion', 'يانسون', 'بابونج'],
    notIn: ['Soft Drinks'] },
  { id: 'milk',
    say: ['7alib', 'halib', '7aleeb', 'haleeb', 'حليب', 'milk', 'lait'],
    tags: ['milk', 'lait', 'حليب', 'بودرة حليب', 'nido', 'نيدو'],
    notIn: ['Chocolate, Biscuits & Candy', 'Ice Cream', 'Soft Drinks', 'Cakes, Desserts & Baking'] },
  { id: 'cheese',
    say: ['jebne', 'jebneh', 'jibne', 'jibneh', 'جبنة', 'جبنه', 'جبن', 'cheese', 'fromage'],
    tags: ['cheese', 'fromage', 'جبن', 'جبنة', 'jebne', 'halloumi', 'حلوم', 'akawi', 'عكاوي', 'kashkaval', 'قشقوان', 'feta', 'فيتا'],
    notIn: ['Chips & Nuts'] },
  { id: 'bread',
    say: ['khebez', '5ebez', 'khebz', 'khobz', 'kheboz', 'خبز', 'bread', 'pain'],
    tags: ['خبز', 'bread', 'pain', 'toast', 'توست', 'كعك', 'baguette'],
    notIn: ['Milk & Cereals'] },
  { id: 'ice_cream',
    say: ['bouza', 'buza', 'boza', 'بوظة', 'بوظه', 'ice cream', 'icecream', 'glace', 'gelato', 'glaces'],
    tags: ['ice cream', 'بوظة', 'glace', 'magnum', 'ماغنوم', 'cornetto', 'كورنيتو', 'extreme'] },
  { id: 'nuts',
    say: ['mkasarat', 'mkassarat', 'mokassarat', 'مكسرات', 'nuts', 'bzourat', 'bzurat', 'بزورات', 'pistache', 'fosto2', 'fostu2', 'فستق'],
    tags: ['nut', 'nuts', 'مكسرات', 'بزورات', 'pistach', 'فستق', 'لوز', 'almond', 'كاجو', 'cashew', 'بزر', 'peanut', 'noisette', 'بندق'] },
  { id: 'canned',
    say: ['konserva', 'kounserva', 'conserve', 'conserves', 'معلبات', 'معلب', 'canned'],   // not "cans": a can of Pepsi is not tinned food
    tags: ['conserve', 'canned', 'معلب', 'tuna', 'تونة', 'تون', 'sardine', 'سردين', 'corned', 'luncheon', 'لانشون'],
    notIn: ['Sashimi'] },
  { id: 'cleaning',
    say: ['tandif', 'tanzif', 'تنظيف', 'منظف', 'منظفات', 'cleaning', 'cleaner', 'detergent', 'detergents', 'nettoyage', 'mon7af'],
    tags: ['deterg', 'antisept', 'تنظيف', 'منظف', 'clean', 'nettoy', 'javel', 'جافيل', 'clorox', 'كلوركس', 'dettol', 'ديتول', 'fairy', 'فيري', 'سائل جلي', 'dish', 'لافاجيل'],
    food: false },
  { id: 'tobacco',
    say: ['dekhen', 'dikhen', 'dukhan', 'دخان', 'cigarette', 'cigarettes', 'sigara', 'sigarat', 'سيجارة', 'سجائر', 'tabac', 'tobacco', 'ma3asel', 'معسل'],
    tags: ['tabac', 'tobacco', 'cigarette', 'دخان', 'سجائر', 'سيجارة', 'marlboro', 'مارلبورو', 'cedars', 'سيدرز', 'winston', 'ونستون', 'gitanes', 'معسل', 'ma3sal', 'kent', 'davidoff'],
    food: false },
  { id: 'beer',
    say: ['beer', 'beers', 'bira', 'birra', 'بيرة', 'بيره', 'biere', 'bière'],
    tags: ['beer', 'bira', 'بيرة', 'biere', 'almaza', 'ألمازة', 'ألمازا', 'heineken', 'هاينكن', 'efes', 'إفس', 'beirut beer', 'بيرة بيروت', 'corona', 'kronenbourg', 'stella'] },
  { id: 'alcohol',
    say: ['alcohol', 'alcool', 'ka7oul', 'kohol', 'كحول', 'wine', 'nbid', 'نبيذ', 'arak', '3ara2', 'عرق', 'whisky', 'whiskey', 'vodka'],
    tags: ['alcool', 'alcohol', 'beer', 'bira', 'بيرة', 'wine', 'نبيذ', 'arak', 'عرق', 'whisk', 'ويسكي', 'vodka', 'فودكا', 'almaza', 'ألمازا', 'heineken', 'tequila'] },
];
