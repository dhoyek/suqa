// The folding and matcher live in pos-core so the point of sale (offline) and the storefront search the same way.
export { normText, skelWords, foldItem, makeMatcher, foldForSearch, searchItems, type Folded, type SearchFold } from '@suqa/pos-core';
