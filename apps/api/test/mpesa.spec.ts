import { darajaTimestamp, DarajaMpesaAdapter, MockMpesa, normalisePhone, parseStkCallback } from '../src/modules/pos/mpesa';

describe('M-Pesa (Daraja) helpers and adapter', () => {
  it('normalises Kenyan mobile numbers', () => {
    expect(normalisePhone('0712 345 678')).toBe('254712345678');
    expect(normalisePhone('+254 110 123456')).toBe('254110123456');
    expect(normalisePhone('712345678')).toBe('254712345678');
    expect(() => normalisePhone('0201234567')).toThrow(/not a Kenyan mobile/);
  });

  it('formats the Daraja timestamp in Nairobi time', () => {
    expect(darajaTimestamp(new Date('2026-10-26T07:15:30Z'))).toBe('20261026101530');
  });

  it('parses STK callbacks (success with metadata, cancellation without)', () => {
    const ok = parseStkCallback(MockMpesa.callbackBody({ checkoutRequestId: 'ws_1', merchantRequestId: 'm1', resultCode: '0', resultDesc: 'ok', receiptNo: 'SJK4H7Q2LM', amount: 150, phone: '254712345678', transactionDate: new Date('2026-10-26T07:15:30Z') }));
    expect(ok).toEqual({ checkoutRequestId: 'ws_1', merchantRequestId: 'm1', resultCode: '0', resultDesc: 'ok', receiptNo: 'SJK4H7Q2LM', amount: 150, phone: '254712345678', transactionDate: new Date('2026-10-26T07:15:30Z') });
    expect(parseStkCallback({ Body: { stkCallback: { CheckoutRequestID: 'ws_2', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } })).toMatchObject({ resultCode: '1032', receiptNo: null, amount: null });
    expect(parseStkCallback({ nonsense: true })).toBeNull();
  });

  it('calls Daraja with OAuth, the shortcode password and the till as PartyB; reads a pending query as null', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const real = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' }));
      if (url.includes('stkpushquery')) return new Response(JSON.stringify({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }), { status: 500 });
      return new Response(JSON.stringify({ MerchantRequestID: 'M', CheckoutRequestID: 'ws_X', ResponseCode: '0', CustomerMessage: 'Success. Request accepted for processing' }));
    }) as typeof fetch;
    try {
      const a = new DarajaMpesaAdapter({ baseUrl: 'https://sandbox.safaricom.co.ke', consumerKey: 'k', consumerSecret: 's', shortcode: '174379', passkey: 'pk', transactionType: 'CustomerBuyGoodsOnline', partyB: '5123456' });
      const r = await a.stkPush({ phone: '254712345678', amount: 99.5, accountRef: 'TILL-OPD-1-LONGER', description: 'Pharmacy purchase', callbackUrl: 'https://x/cb' }, 5000);
      expect(r).toMatchObject({ ok: true, checkoutRequestId: 'ws_X' });
      expect(calls[0].init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from('k:s').toString('base64')}` });
      const body = JSON.parse(String(calls[1].init?.body));
      expect(body).toMatchObject({ BusinessShortCode: '174379', TransactionType: 'CustomerBuyGoodsOnline', Amount: 100, PartyA: '254712345678', PartyB: '5123456', AccountReference: 'TILL-OPD-1-L', TransactionDesc: 'Pharmacy purc' });
      expect(Buffer.from(body.Password, 'base64').toString()).toBe(`174379pk${body.Timestamp}`);
      expect(await a.stkQuery('ws_X', 5000)).toBeNull();
      expect(calls.filter((c) => c.url.includes('/oauth/'))).toHaveLength(1); // token reused
    } finally {
      global.fetch = real;
    }
  });
});
