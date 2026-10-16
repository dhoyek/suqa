import { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createSuqaClient, resolveTenantBySlug, type Tenant } from '@suqa/shared';

const sb = createSuqaClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { storage: AsyncStorage });

export default function App() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  useEffect(() => { resolveTenantBySlug(sb, Constants.expoConfig?.extra?.tenantSlug ?? 'batroun').then(setTenant); }, []);
  return (
    <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 24, color: tenant?.branding.colors?.primary ?? '#000' }}>{tenant?.brand_name ?? 'Loading…'}</Text>
    </SafeAreaView>
  );
}
