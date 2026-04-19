const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const key = Deno.env.get('POLY_PRIVATE_KEY') ?? '';
  return new Response(JSON.stringify({ poly_private_key: key }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
