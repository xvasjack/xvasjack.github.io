<?php
/*
Template Name: Contact
Template Post Type: page
*/
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>
<main>
      <section class="hero">
        <div class="container grid grid-2">
          <div class="reveal">
            <p class="section-kicker">Contact</p>
            <h1>Talk to the KreatBio team</h1>
            <p class="lead">Share your lab or training goal. We will guide you to the right setup.</p>

            <div class="card" style="margin-top: 1rem">
              <h3>Typical requests</h3>
              <ul class="ticks">
                <li><span class="tick-icon">+</span><span>KreatPure pricing and product fit discussion.</span></li>
                <li><span class="tick-icon">+</span><span>KodaGeno classroom or training demo scheduling.</span></li>
                <li><span class="tick-icon">+</span><span>Protocol or document package request.</span></li>
              </ul>
            </div>
          </div>

          <div class="card reveal">
            <h2>Send request</h2>
            <form>
              <div class="form-grid">
                <div>
                  <label for="name">Name</label>
                  <input id="name" name="name" type="text" placeholder="Your full name" />
                </div>
                <div>
                  <label for="email">Work email</label>
                  <input id="email" name="email" type="email" placeholder="name@company.com" />
                </div>
                <div>
                  <label for="org">Organization</label>
                  <input id="org" name="org" type="text" placeholder="Company or university" />
                </div>
                <div>
                  <label for="country">Country</label>
                  <input id="country" name="country" type="text" placeholder="Country" />
                </div>
                <div class="full">
                  <label for="interest">I am interested in</label>
                  <select id="interest" name="interest">
                    <option>KreatPure DNA Extraction Kit</option>
                    <option>KodaGeno Bioinformatics Learning Platform</option>
                    <option>Both products</option>
                    <option>General inquiry</option>
                  </select>
                </div>
                <div class="full">
                  <label for="message">Message</label>
                  <textarea id="message" name="message" placeholder="Tell us your use case and timeline"></textarea>
                </div>
              </div>
              <p style="margin-top: 0.9rem"><button class="btn btn-primary" type="submit">Send Request</button></p>
            </form>
            <p style="margin-top: 0.75rem; color: var(--muted)">Support target reply: within 1 business day.</p>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="notice reveal">Replace this form with your real form plugin endpoint before going live.</div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
