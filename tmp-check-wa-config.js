const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

p.mobileAppSetting
  .findUnique({
    where: { key: 'mobile_app_whatsapp_otp_config_v1' },
    select: { value: true },
  })
  .then((r) => {
    if (!r?.value) {
      console.log('NO_ROW');
      return;
    }
    const o = JSON.parse(r.value);
    const u = new URL(o.apiBaseUrl);
    console.log(
      JSON.stringify({
        enabled: o.enabled,
        protocol: u.protocol,
        host: u.host,
        pathname: u.pathname,
        instanceName: o.instanceName,
        apiKeyLen: String(o.apiKey || '').length,
      }),
    );
  })
  .catch((e) => {
    console.error('ERR', String(e.message).split(':')[0]);
    process.exitCode = 1;
  })
  .finally(() => p.$disconnect());
