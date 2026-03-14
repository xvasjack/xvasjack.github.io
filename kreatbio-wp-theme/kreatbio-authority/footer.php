    <footer class="site-footer">
      <div class="container footer-grid">
        <div>
          <div class="brand" style="margin-bottom: 0.6rem">
            <span class="brand-mark">KB</span>
            <span class="brand-text">
              <span class="brand-name">KreatBio</span>
              <span class="brand-sub">Research and Educational Biotech Tools</span>
            </span>
          </div>
          <p style="color: var(--muted)">Practical products for labs and learning teams.</p>
        </div>

        <div>
          <p class="footer-head">Products</p>
          <ul class="footer-links">
            <li><a href="<?php echo esc_url(kreatbio_authority_page_url('kreatpure-dna-kit')); ?>">KreatPure DNA Extraction Kit</a></li>
            <li><a href="<?php echo esc_url(kreatbio_authority_page_url('kodageno-learning-platform')); ?>">KodaGeno Bioinformatics Learning Platform</a></li>
          </ul>
        </div>

        <div>
          <p class="footer-head">Company</p>
          <ul class="footer-links">
            <li><a href="<?php echo esc_url(kreatbio_authority_page_url('about')); ?>">About</a></li>
            <li><a href="<?php echo esc_url(kreatbio_authority_page_url('resources')); ?>">Resources</a></li>
            <li><a href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Contact</a></li>
          </ul>
        </div>
      </div>

      <div class="container footer-bottom">
        <span>&copy; <span data-year></span> KreatBio. All rights reserved.</span>
        <span>For research and educational use only. Not intended for diagnostic use.</span>
      </div>
    </footer>

    <?php wp_footer(); ?>
  </body>
</html>