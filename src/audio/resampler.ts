/** Stateful windowed-sinc resampler. Keeps filter history across input blocks. */
export class MonoResampler {
    private tail = new Float32Array(0);
    private consumed = 0;
    private produced = 0;
    private readonly radius = 24;
    private readonly phases: Float64Array[];
    constructor(
        private readonly rate: number,
        private readonly target = 16000,
    ) {
        const cutoff = Math.min(1, target / rate) * 0.94;
        this.phases = Array.from({ length: 1024 }, (_, phase) => {
            const weights = new Float64Array(this.radius * 2);
            let sum = 0;
            for (let k = 0; k < weights.length; k++) {
                const x = k - this.radius + 1 - phase / 1024;
                const sinc =
                    x === 0
                        ? cutoff
                        : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
                const window =
                    0.5 + 0.5 * Math.cos((Math.PI * x) / this.radius);
                weights[k] = sinc * window;
                sum += weights[k];
            }
            for (let k = 0; k < weights.length; k++) weights[k] /= sum;
            return weights;
        });
    }
    push(channels: Float32Array[], final = false): Float32Array {
        const count = channels[0]?.length ?? 0;
        if (this.rate === this.target) {
            if (channels.length === 1) return channels[0];
            const mono = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                for (const channel of channels)
                    mono[i] += channel[i] / channels.length;
            }
            return mono;
        }
        const input = new Float32Array(this.tail.length + count);
        input.set(this.tail);
        for (let i = 0; i < count; i++) {
            let sum = 0;
            for (const channel of channels) sum += channel[i];
            input[this.tail.length + i] = sum / channels.length;
        }
        const start = this.consumed - this.tail.length;
        this.consumed += count;
        const end = final
            ? Math.floor((this.consumed * this.target) / this.rate)
            : Math.max(
                  this.produced,
                  Math.ceil(
                      ((this.consumed - this.radius) * this.target) / this.rate,
                  ),
              );
        const output = new Float32Array(end - this.produced);
        for (let i = 0; this.produced < end; i++, this.produced++) {
            const position = (this.produced * this.rate) / this.target;
            const center = Math.floor(position);
            const weights =
                this.phases[
                    Math.min(1023, Math.floor((position - center) * 1024))
                ];
            let sum = 0;
            for (let k = 0; k < weights.length; k++) {
                const index = center - this.radius + 1 + k - start;
                sum += (input[index] ?? 0) * weights[k];
            }
            output[i] = sum;
        }
        this.tail = input.slice(Math.max(0, input.length - this.radius * 2));
        return output;
    }
}
