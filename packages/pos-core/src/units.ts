// Which items are sold by measure. An item sold by the kilo, the gram, the litre… is bought in parts ("0.5 kg", "1.25 l"), so its
// quantity may be a decimal wherever a quantity is entered — the till, an order being edited, a purchase, the customer's basket —
// whether or not somebody ticked "decimal quantity" on it. Only a BARE unit counts: "kg" is a measure, "400 g" or "½ kg" is the size of
// a pack that is sold whole.
const MEASURES = new Set(['kg', 'kgs', 'kilo', 'kilos', 'g', 'gr', 'gm', 'gram', 'grams', 'l', 'lt', 'ltr', 'liter', 'litre', 'liters', 'litres', 'ml', 'cl', 'm', 'meter', 'metre', 'cm', 'lb', 'oz',
  'كغ', 'كلغ', 'كيلو', 'كيلوغرام', 'غ', 'غرام', 'ل', 'لتر', 'ليتر', 'مل', 'م', 'متر', 'سم']);
export const isMeasureUnit = (u: string | null | undefined): boolean => !!u && MEASURES.has(u.trim().toLowerCase().replace(/\.$/, ''));
/** may this item's quantity be a decimal? its own setting, or a unit that is a measure */
export const allowsDecimal = (p: { decimal_qty?: boolean | null; unit?: string | null; unit_kind?: string | null } | null | undefined): boolean =>
  !!p && (!!p.decimal_qty || isMeasureUnit(p.unit) || (p.unit_kind !== 'piece' && p.unit_kind !== 'pack' && isMeasureUnit(p.unit_kind)));
