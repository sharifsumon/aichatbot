export const metadata = { title: 'Privacy policy · Agently' };

/** Plain-language privacy policy, also the URL given to Meta for App Review. */
export default function PrivacyPage() {
  const contact = process.env.CONTACT_EMAIL;
  const api = (process.env.API_URL ?? '').replace(/\/+$/, '');
  return (
    <main className="legal">
      <a href="/" className="crumb">
        ← Agently
      </a>
      <h1>Privacy policy</h1>
      <p className="sub">Last updated 8 November 2026</p>
      <p>
        Agently helps shops answer their Facebook page messages and comments with an AI assistant, take orders and keep track of them. This page explains what we
        collect, why, and how to have it deleted.
      </p>

      <h2>Shop owners and their team</h2>
      <ul>
        <li>When you continue with Facebook we receive your name, your Facebook user ID and, if you allow it, your email address.</li>
        <li>We receive a list of the Facebook pages you manage, and an access token for each page you connect. Tokens are stored encrypted.</li>
        <li>We keep your shop&apos;s settings, products, knowledge base and team members so the service works.</li>
      </ul>

      <h2>Customers who message a shop</h2>
      <ul>
        <li>We receive the messages and comments people send to a connected page, with their name and Facebook page-scoped ID.</li>
        <li>If a customer orders, we keep what they share for the order: name, phone number, delivery address and any bKash or Nagad transaction ID.</li>
        <li>This data belongs to the shop. It is shown only to that shop&apos;s team and, when the shop asks for help, to Agently support. Support access is logged.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To write replies, we send the conversation and the shop&apos;s own information to an AI model provider. They process it only to produce the reply.</li>
        <li>To show the shop its inbox, orders and reports.</li>
        <li>We do not sell personal data and we do not use it for advertising.</li>
      </ul>

      <h2>Deleting your data</h2>
      <ul>
        <li>
          Remove Agently from your Facebook settings (Settings &amp; privacy → Settings → Apps and websites). Facebook tells us, and we delete your Agently sign-in and account. Shop
          data (products, orders, chats) stays with the shop until its owner deletes it, since other staff may run it. You get a confirmation code you can check{api ? <> at {api}/webhooks/meta/data-deletion/&lt;code&gt;</> : null}.
        </li>
        <li>A shop owner can disconnect a page at any time in Settings. We then stop receiving its messages and delete its access token.</li>
        {contact && (
          <li>
            Or email <a href={`mailto:${contact}`}>{contact}</a> and we will delete it for you.
          </li>
        )}
      </ul>

      <h2>Keeping data safe</h2>
      <p>Data is stored on servers we control, access tokens are encrypted, and connections use HTTPS.</p>

      {contact && (
        <>
          <h2>Contact</h2>
          <p>
            Questions about this policy: <a href={`mailto:${contact}`}>{contact}</a>.
          </p>
        </>
      )}
    </main>
  );
}
