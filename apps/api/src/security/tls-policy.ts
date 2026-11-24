/** Must evaluate before application imports can start network clients. */
export function assertTlsVerification(){if(process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='1')throw Error('API requires enabled TLS certificate verification');}
assertTlsVerification();
