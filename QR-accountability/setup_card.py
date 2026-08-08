"""
One-time setup: saves a card to Stripe for later off-session charging
by the QR-accountability Worker. Run this once, locally, on your machine.
 
    export STRIPE_SECRET_KEY=sk_live_...      (or sk_test_... while testing)
    pip install stripe
    python setup_card.py
 
Re-run this later if the card ever needs replacing — it's harmless to
create a new customer/payment method and just overwrite the stored IDs.
"""
 
import os
import sys
import webbrowser
 
import stripe
 
stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")
if not stripe.api_key:
    sys.exit("Set STRIPE_SECRET_KEY in your environment first.")
 
 
def main():
    # 1. Create the customer object (this just represents "you")
    customer = stripe.Customer.create(description="qr-accountability")
    print(f"\nCreated customer: {customer.id}")
 
    # 2. Create a Checkout Session in setup mode, attached to that customer
    session = stripe.checkout.Session.create(
        mode="setup",
        customer=customer.id,
        currency="usd",
        success_url="https://example.com/done?session_id={CHECKOUT_SESSION_ID}",
    )
 
    print("\nOpen this URL and enter your card:")
    print(session.url)
    try:
        webbrowser.open(session.url)
    except Exception:
        pass  # fine if this fails headless — the printed URL still works
 
    input("\nPress Enter once you've completed the checkout page... ")
 
    session_id = input(
        "Paste the session_id value from the redirected URL's query string: "
    ).strip()
 
    # 3. Retrieve the completed session, expanding straight to the payment method
    completed = stripe.checkout.Session.retrieve(
        session_id,
        expand=["setup_intent.payment_method"],
    )
    payment_method_id = completed.setup_intent.payment_method.id
 
    print("\n--- Store these in D1 ---")
    print(f"customer_id:        {customer.id}")
    print(f"payment_method_id:  {payment_method_id}")
 
    print("\nOr run directly:")
    print(
        "wrangler d1 execute YOUR_DB_NAME --remote --command \""
        f"INSERT INTO billing_config (customer_id, payment_method_id) "
        f"VALUES ('{customer.id}', '{payment_method_id}');\""
    )
 
 
if __name__ == "__main__":
    main()
 
