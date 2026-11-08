import { redirect } from 'next/navigation';

// Orders and products are managed in the POS (/pos); the dashboard keeps only the storefront profile.
export default function ShopHome() { redirect('/shop/settings'); }
