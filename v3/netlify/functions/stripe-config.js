exports.handler = async () => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  if (!publishableKey) {
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'STRIPE_NOT_CONFIGURED',
      message: 'Stripe test mode is not configured yet.',
    });
  }

  return jsonResponse(200, {
    publishableKey,
  });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}
