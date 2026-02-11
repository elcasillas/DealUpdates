#!/bin/bash
# Generate supabase-config.js from environment variables during Vercel build

if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_ANON_KEY" ]; then
    cat > js/supabase-config.js <<EOF
// Auto-generated during build from environment variables
const SUPABASE_URL = '${SUPABASE_URL}';
const SUPABASE_ANON_KEY = '${SUPABASE_ANON_KEY}';
EOF
    echo "supabase-config.js generated successfully."
else
    echo "WARNING: SUPABASE_URL or SUPABASE_ANON_KEY not set. Supabase will run in offline mode."
fi
