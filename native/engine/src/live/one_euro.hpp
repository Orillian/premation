// One Euro filter (Casiez, Roussel, Vogel 2012) over a fixed set of values —
// a hand's 21 landmarks. Still hands stop shaking (low cutoff), fast hands do
// not lag (the cutoff rises with speed). Pure; deterministic for a given
// sample sequence.
#pragma once

#include <cmath>
#include <vector>

namespace premation::live {

class OneEuro {
 public:
  /// `minCutoff` Hz at rest; `beta` how fast the cutoff rises with speed (units / s); `dCutoff` Hz for the speed itself.
  OneEuro(double minCutoff, double beta, double dCutoff = 1.0) : minCutoff_(minCutoff), beta_(beta), dCutoff_(dCutoff) {}

  /// Filter `x` (in place) sampled `dt` seconds after the previous call. The
  /// first call, a size change or dt ≤ 0 restarts from `x` unfiltered.
  void filter(std::vector<double>& x, double dt) {
    if (prev_.size() != x.size() || dt <= 0) {
      prev_ = x;
      dPrev_.assign(x.size(), 0.0);
      return;
    }
    const double ad = alpha(dCutoff_, dt);
    for (std::size_t i = 0; i < x.size(); ++i) {
      const double d = (x[i] - prev_[i]) / dt;
      dPrev_[i] = ad * d + (1 - ad) * dPrev_[i];
      const double a = alpha(minCutoff_ + beta_ * std::abs(dPrev_[i]), dt);
      prev_[i] = a * x[i] + (1 - a) * prev_[i];
      x[i] = prev_[i];
    }
  }

  void reset() {
    prev_.clear();
    dPrev_.clear();
  }

 private:
  static double alpha(double cutoff, double dt) {
    constexpr double kTwoPi = 6.28318530717958647692;
    const double tau = 1.0 / (kTwoPi * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  double minCutoff_;
  double beta_;
  double dCutoff_;
  std::vector<double> prev_;
  std::vector<double> dPrev_;
};

}  // namespace premation::live
